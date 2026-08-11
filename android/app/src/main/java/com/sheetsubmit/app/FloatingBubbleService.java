package com.sheetsubmit.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Point;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.hardware.display.DisplayManager;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.os.SystemClock;
import android.util.Log;
import android.view.Display;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.Toast;

public class FloatingBubbleService extends Service {

    private static final String TAG = "FloatingBubble";
    private static final String CHANNEL_ID = "bubble";
    private static final int NOTIFICATION_ID = 3;
    private static final String PREFS_NAME = "sheetsubmit";
    private static final String KEY_FILE = "bubble_file";
    private static final String KEY_CLIP = "bubble_clip";
    private static final String KEY_CLIP_AT = "bubble_clip_at";
    private static final String KEY_BUBBLE_X = "bubble_x";
    private static final String KEY_BUBBLE_Y = "bubble_y";
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
    private long panelShownAt;
    private boolean panelShowing;

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
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !android.provider.Settings.canDrawOverlays(this)) {
            Log.e(TAG, "overlay permission missing, stopping");
            stopSelf();
            return;
        }

        String bubbleFileId = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getString(KEY_FILE, "");
        if (bubbleFileId.isEmpty()) {
            Log.i(TAG, "No bubble file set, stopping");
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
        Log.i(TAG, "service running, bubble visible");
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

    @SuppressWarnings("deprecation")
    private int displayWidth() {
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                return windowManager.getCurrentWindowMetrics().getBounds().width();
            }
            Point p = new Point();
            windowManager.getDefaultDisplay().getSize(p);
            return p.x;
        } catch (Exception e) {
            return getResources().getDisplayMetrics().widthPixels;
        }
    }

    @SuppressWarnings("deprecation")
    private int displayHeight() {
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                return windowManager.getCurrentWindowMetrics().getBounds().height();
            }
            Point p = new Point();
            windowManager.getDefaultDisplay().getSize(p);
            return p.y;
        } catch (Exception e) {
            return getResources().getDisplayMetrics().heightPixels;
        }
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
        SharedPreferences posPrefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        bubbleParams.x = posPrefs.getInt(KEY_BUBBLE_X, Math.max(0, displayWidth() - windowSize - dp(16)));
        bubbleParams.y = posPrefs.getInt(KEY_BUBBLE_Y, dp(220));

        root.setOnTouchListener(bubbleTouchListener);
        bubbleView = root;
        try {
            windowManager.addView(bubbleView, bubbleParams);
        } catch (Exception e) {
            Log.e(TAG, "addBubbleToWindow failed", e);
            Toast.makeText(this, "Cannot display overlay — allow the permission", Toast.LENGTH_LONG).show();
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
                    getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit()
                            .putInt(KEY_BUBBLE_X, bubbleParams.x)
                            .putInt(KEY_BUBBLE_Y, bubbleParams.y)
                            .apply();
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
        if (panelRoot != null || panelShowing) {
            hidePanel();
        } else {
            showPanel();
        }
    }

    private void showPanel() {
        if (panelShowing) return;
        panelShowing = true;
        try {
            int scrW = displayWidth();
            int scrH = displayHeight();
            int panelW = Math.min(dp(240), Math.max(200, scrW - dp(20)));
            panelW = Math.min(panelW, scrW - dp(8));
            int panelH = Math.min(dp(300), Math.max(240, scrH - dp(40)));
            panelH = Math.min(panelH, scrH - dp(16));

            panelRoot = new FrameLayout(this);
            panelRoot.setBackgroundColor(0x33000000);

            LinearLayout card = new LinearLayout(this);
            card.setOrientation(LinearLayout.VERTICAL);
            GradientDrawable cardBg = new GradientDrawable();
            cardBg.setColor(0xFFFFFFFF);
            cardBg.setCornerRadius(dp(18));
            card.setBackground(cardBg);
            FrameLayout.LayoutParams cardParams = new FrameLayout.LayoutParams(panelW, panelH, Gravity.TOP | Gravity.CENTER_HORIZONTAL);
            int bubbleCenterY = bubbleParams.y + bubbleParams.height / 2;
            cardParams.topMargin = clamp(bubbleCenterY - panelH / 2, dp(8), Math.max(dp(8), scrH - panelH - dp(8)));
            card.setLayoutParams(cardParams);

            ensureMiniWebView();
            if (miniWebView != null) {
                ViewGroup oldParent = (ViewGroup) miniWebView.getParent();
                if (oldParent != null) oldParent.removeView(miniWebView);
                LinearLayout.LayoutParams wlp = new LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f);
                card.addView(miniWebView, wlp);
                miniWebView.onResume();
                try {
                    Intent cap = new Intent(this, ClipboardCaptureActivity.class);
                    cap.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(cap);
                } catch (Exception e) {
                    Log.w(TAG, "ClipboardCaptureActivity failed, using fallback", e);
                    try {
                        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                        if (cm != null && cm.hasPrimaryClip() && cm.getPrimaryClip() != null && cm.getPrimaryClip().getItemCount() > 0) {
                            CharSequence cs = cm.getPrimaryClip().getItemAt(0).getText();
                            String text = cs != null ? cs.toString() : "";
                            getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                                .edit()
                                .putString(KEY_CLIP, text)
                                .putLong(KEY_CLIP_AT, System.currentTimeMillis())
                                .apply();
                        }
                    } catch (Exception ignored) {}
                }
            panelRoot.setFocusableInTouchMode(true);
            final int[] pollCount = {0};
            final Runnable pollRunnable = new Runnable() {
                @Override
                public void run() {
                    pollCount[0]++;
                    SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                    long clipAt = prefs.getLong(KEY_CLIP_AT, 0);
                    boolean captured = clipAt > 0 && System.currentTimeMillis() - clipAt < 2000;
                    if (captured || pollCount[0] >= 10) {
                        try {
                            panelRoot.requestFocus();
                            if (miniWebView != null) miniWebView.requestFocus();
                            miniWebView.evaluateJavascript("window.__ss&&window.__ss.bubbleAutomate&&window.__ss.bubbleAutomate();", null);
                        } catch (Exception ignored) {}
                    } else {
                        panelRoot.postDelayed(this, 200);
                    }
                }
            };
            panelRoot.postDelayed(pollRunnable, 200);
            }

            panelRoot.addView(card);
            panelRoot.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    if (SystemClock.elapsedRealtime() - panelShownAt > 350) {
                        hidePanel();
                    }
                }
            });
            card.setClickable(true);

            WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                    WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT,
                    overlayType(), 0, PixelFormat.TRANSLUCENT);
            lp.gravity = Gravity.TOP | Gravity.START;
            lp.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE;
            windowManager.addView(panelRoot, lp);
            panelShownAt = SystemClock.elapsedRealtime();
            Log.i(TAG, "panel shown " + panelW + "x" + panelH);
        } catch (Exception e) {
            Log.e(TAG, "showPanel failed", e);
            panelShowing = false;
            if (panelRoot != null) {
                try { windowManager.removeView(panelRoot); } catch (Exception ignored) {}
                panelRoot = null;
            }
        }
    }

    private void ensureMiniWebView() {
        if (miniWebView != null) {
            try {
                miniWebView.getUrl();
                return;
            } catch (Exception e) {
                try { miniWebView.destroy(); } catch (Exception ignored) {}
                miniWebView = null;
            }
        }
        try {
            miniWebView = new WebView(this);
            WebSettings ws = miniWebView.getSettings();
            ws.setJavaScriptEnabled(true);
            ws.setDomStorageEnabled(true);
            ws.setDatabaseEnabled(true);
            ws.setLoadWithOverviewMode(true);
            ws.setUseWideViewPort(true);
            miniWebView.setWebViewClient(new WebViewClient() {
                @Override
                public void onPageFinished(WebView view, String url) {
                    super.onPageFinished(view, url);
                    injectClipboardBridge(view);
                }
            });
            miniWebView.addJavascriptInterface(new Object() {
                @JavascriptInterface
                public boolean isApp() { return true; }
                @JavascriptInterface
                public String readClipboard() {
                    try {
                        // Android 10+ only lets focused apps read the clipboard —
                        // prefer the value captured by ClipboardCaptureActivity.
                        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                        long at = prefs.getLong(KEY_CLIP_AT, 0);
                        if (at > 0 && System.currentTimeMillis() - at < 15000) {
                            String captured = prefs.getString(KEY_CLIP, null);
                            if (captured != null) return captured;
                        }
                        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                        if (cm != null && cm.hasPrimaryClip() && cm.getPrimaryClip() != null && cm.getPrimaryClip().getItemCount() > 0) {
                            CharSequence cs = cm.getPrimaryClip().getItemAt(0).getText();
                            return cs != null ? cs.toString() : "";
                        }
                    } catch (Exception ignored) {}
                    return "";
                }
                @JavascriptInterface
                public void writeClipboard(String text) {
                    try {
                        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                        if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("sheetsubmit", text == null ? "" : text));
                    } catch (Exception ignored) {}
                }
            }, "Android");
            SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
            String fileId = prefs.getString(KEY_FILE, "");
            if (!fileId.isEmpty()) {
                String url = HOME_URL + "/?bubble=1&file=" + Uri.encode(fileId);
                miniWebView.loadUrl(url);
                Log.i(TAG, "mini webview loading " + url);
            }
        } catch (Exception e) {
            Log.e(TAG, "ensureMiniWebView failed", e);
            miniWebView = null;
        }
    }

    private void injectClipboardBridge(WebView view) {
        String shim = "(function(){" +
            "if(window.Android&&window.Android.readClipboard&&window.Android.writeClipboard){" +
            "navigator.clipboard.readText=function(){return new Promise(function(res,rej){try{res(window.Android.readClipboard());}catch(e){rej(e);}});};" +
            "navigator.clipboard.writeText=function(t){window.Android.writeClipboard(String(t));return Promise.resolve();};" +
            "navigator.clipboard.read=function(){return Promise.reject(new Error('not supported'));};" +
            "window.nativeClipboardReady=true;}" +
            "})();";
        view.evaluateJavascript(shim, null);
    }

    private void hidePanel() {
        if (miniWebView != null) {
            try { miniWebView.loadUrl("about:blank"); } catch (Exception ignored) {}
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