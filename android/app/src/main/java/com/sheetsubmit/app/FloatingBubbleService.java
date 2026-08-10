package com.sheetsubmit.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Resources;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.hardware.display.DisplayManager;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.util.TypedValue;
import android.view.Display;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

public class FloatingBubbleService extends Service {

    private static final String CHANNEL_ID = "bubble";
    private static final int NOTIFICATION_ID = 3;
    private static final String PREFS_NAME = "sheetsubmit";
    private static final String KEY_FILE = "bubble_file";
    private static final String HOME_URL = "https://sheetsubmit.up.railway.app";

    private WindowManager windowManager;
    private View bubbleView;
    private WindowManager.LayoutParams bubbleParams;
    private FrameLayout panelRoot;
    private WebView miniWebView;
    private int touchSlop;
    private float initialRawX;
    private float initialRawY;
    private int initialBubbleX;
    private int initialBubbleY;
    private boolean dragging;

    public static void start(Context ctx) {
        Intent i = new Intent(ctx, FloatingBubbleService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ctx.startForegroundService(i);
        } else {
            ctx.startService(i);
        }
    }

    public static void stop(Context ctx) {
        ctx.stopService(new Intent(ctx, FloatingBubbleService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !SettingsHolder.canDrawOverlays(this)) {
            stopSelf();
            return;
        }

        createChannel();
        startAsForeground();

        DisplayManager dm = (DisplayManager) getSystemService(Context.DISPLAY_SERVICE);
        Display display = dm.getDisplay(Display.DEFAULT_DISPLAY);
        Context displayCtx = createDisplayContext(display);
        windowManager = (WindowManager) displayCtx.getSystemService(Context.WINDOW_SERVICE);
        touchSlop = ViewConfiguration.get(this).getScaledTouchSlop();

        addBubbleToWindow();
    }

    private static class SettingsHolder {
        static boolean canDrawOverlays(Context ctx) {
            return android.provider.Settings.canDrawOverlays(ctx);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ── Bubble ──

    private int dp(float v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private int displayWidth() {
        return windowManager.getCurrentWindowMetrics().getBounds().width();
    }

    private int displayHeight() {
        return windowManager.getCurrentWindowMetrics().getBounds().height();
    }

    private int overlayType() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;
    }

    private void addBubbleToWindow() {
        int size = dp(60);
        int margin = dp(12);
        int windowSize = size + margin * 2;

        FrameLayout root = new FrameLayout(this);
        root.setClipChildren(false);

        FrameLayout circle = new FrameLayout(this);
        GradientDrawable bg = new GradientDrawable();
        bg.setShape(GradientDrawable.OVAL);
        bg.setColor(0xFFF4F4F5);
        bg.setStroke(dp(1), 0xFFE4E4E7);
        circle.setBackground(bg);
        FrameLayout.LayoutParams clp = new FrameLayout.LayoutParams(size, size, Gravity.CENTER);
        circle.setLayoutParams(clp);

        ImageView icon = new ImageView(this);
        icon.setImageResource(R.mipmap.ic_launcher);
        FrameLayout.LayoutParams ilp = new FrameLayout.LayoutParams(dp(30), dp(30), Gravity.CENTER);
        icon.setLayoutParams(ilp);
        circle.addView(icon);
        root.addView(circle);

        bubbleParams = new WindowManager.LayoutParams(
                windowSize, windowSize, overlayType(),
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
                PixelFormat.TRANSLUCENT);
        bubbleParams.gravity = Gravity.TOP | Gravity.START;
        bubbleParams.x = Math.max(0, displayWidth() - windowSize - dp(16));
        bubbleParams.y = dp(220);

        root.setOnTouchListener(bubbleTouchListener);
        bubbleView = root;
        try {
            windowManager.addView(bubbleView, bubbleParams);
        } catch (Exception e) {
            bubbleView = null;
            stopSelf();
        }
    }

    private final View.OnTouchListener bubbleTouchListener = new View.OnTouchListener() {
        @Override
        public boolean onTouch(View v, MotionEvent ev) {
            switch (ev.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    initialRawX = ev.getRawX();
                    initialRawY = ev.getRawY();
                    initialBubbleX = bubbleParams.x;
                    initialBubbleY = bubbleParams.y;
                    dragging = false;
                    v.animate().scaleX(0.92f).scaleY(0.92f).setDuration(120).start();
                    return true;
                case MotionEvent.ACTION_MOVE:
                    if (Math.abs(ev.getRawX() - initialRawX) > touchSlop
                            || Math.abs(ev.getRawY() - initialRawY) > touchSlop) {
                        hidePanel();
                        dragging = true;
                        int nx = Math.round(initialBubbleX + (ev.getRawX() - initialRawX));
                        int ny = Math.round(initialBubbleY + (ev.getRawY() - initialRawY));
                        bubbleParams.x = clamp(nx, 0, Math.max(0, displayWidth() - bubbleParams.width));
                        bubbleParams.y = clamp(ny, 0, Math.max(0, displayHeight() - bubbleParams.height));
                        windowManager.updateViewLayout(bubbleView, bubbleParams);
                    }
                    return true;
                case MotionEvent.ACTION_UP:
                    v.animate().scaleX(1f).scaleY(1f).setDuration(150).start();
                    if (!dragging) {
                        v.performClick();
                        togglePanel();
                    }
                    return true;
                case MotionEvent.ACTION_CANCEL:
                    dragging = false;
                    v.animate().scaleX(1f).scaleY(1f).setDuration(150).start();
                    return true;
            }
            return false;
        }
    };

    private int clamp(int v, int min, int max) {
        return Math.max(min, Math.min(v, max));
    }

    // ── Mini panel ──

    private void togglePanel() {
        if (panelRoot != null) {
            hidePanel();
        } else {
            showPanel();
        }
    }

    private void showPanel() {
        int scrW = displayWidth();
        int scrH = displayHeight();
        int panelW = Math.min(dp(240), Math.max(200, scrW - dp(16)));
        int panelH = Math.min(dp(300), Math.max(240, scrH - dp(32)));

        panelRoot = new FrameLayout(this);
        panelRoot.setBackgroundColor(0x33000000);

        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        GradientDrawable cardBg = new GradientDrawable();
        cardBg.setColor(0xFFFFFFFF);
        cardBg.setCornerRadius(dp(14));
        card.setBackground(cardBg);
        FrameLayout.LayoutParams cardParams = new FrameLayout.LayoutParams(panelW, panelH, Gravity.TOP | Gravity.CENTER_HORIZONTAL);
        int bubbleCenterY = bubbleParams.y + bubbleParams.height / 2;
        cardParams.topMargin = clamp(bubbleCenterY - panelH / 2, dp(8), Math.max(dp(8), scrH - panelH - dp(8)));
        card.setLayoutParams(cardParams);

        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(dp(14), dp(8), dp(4), dp(8));

        TextView title = new TextView(this);
        title.setText("SheetSubmit");
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        title.setTextColor(0xFF18181B);
        title.setTypeface(title.getTypeface(), Typeface.BOLD);
        LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        title.setLayoutParams(tlp);
        header.addView(title);

        TextView close = new TextView(this);
        close.setText("✕");
        close.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
        close.setTextColor(0xFF71717A);
        close.setPadding(dp(12), dp(4), dp(12), dp(4));
        close.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                hidePanel();
            }
        });
        header.addView(close);
        card.addView(header);

        miniWebView = new WebView(this);
        WebSettings ws = miniWebView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setDatabaseEnabled(true);
        ws.setLoadWithOverviewMode(true);
        miniWebView.setWebViewClient(new WebViewClient());
        LinearLayout.LayoutParams wlp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f);
        miniWebView.setLayoutParams(wlp);
        card.addView(miniWebView);

        panelRoot.addView(card);
        panelRoot.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                hidePanel();
            }
        });
        card.setClickable(true);

        WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT,
                overlayType(), 0, PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.START;
        lp.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE;
        try {
            windowManager.addView(panelRoot, lp);
        } catch (Exception e) {
            panelRoot = null;
            return;
        }

        miniWebView.onResume();
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        String fileId = prefs.getString(KEY_FILE, "");
        if (!fileId.isEmpty()) {
            miniWebView.loadUrl(HOME_URL + "/?bubble=1&file=" + Uri.encode(fileId));
        }
    }

    private void hidePanel() {
        if (miniWebView != null) {
            try { miniWebView.onPause(); } catch (Exception ignored) {}
        }
        if (panelRoot != null) {
            try { windowManager.removeView(panelRoot); } catch (Exception ignored) {}
            panelRoot = null;
        }
    }

    // ── Foreground notification ──

    private void createChannel() {
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Floating bubble", NotificationManager.IMPORTANCE_LOW);
        ch.setShowBadge(false);
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        nm.createNotificationChannel(ch);
    }

    private void startAsForeground() {
        Intent openApp = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(this, 0, openApp, PendingIntent.FLAG_IMMUTABLE);
        Notification n = new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("SheetSubmit bubble")
                .setContentText("Mini sheet is active")
                .setOngoing(true)
                .setContentIntent(pi)
                .build();
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, n, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION_ID, n);
        }
    }

    @Override
    public void onDestroy() {
        hidePanel();
        if (miniWebView != null) {
            miniWebView.destroy();
            miniWebView = null;
        }
        if (bubbleView != null) {
            try { windowManager.removeView(bubbleView); } catch (Exception ignored) {}
            bubbleView = null;
        }
        super.onDestroy();
    }
}