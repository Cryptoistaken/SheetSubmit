package com.sheetsubmit.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.app.ActivityOptions;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Point;
import android.graphics.PixelFormat;
import android.graphics.PorterDuff;
import android.graphics.drawable.GradientDrawable;
import android.hardware.display.DisplayManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.util.Log;
import android.view.Display;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.animation.AccelerateDecelerateInterpolator;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.Toast;

public class FloatingBubbleService extends Service {

    private static final String TAG = "SheetSubmitBubble";
    private static final String CHANNEL_ID = "sheetsubmit_bubble";
    private static final int NOTIFICATION_ID = 103;
    private static final long LONG_PRESS_MS = 500L;
    private static final String PREFS_NAME = "sheetsubmit";
    private static final String KEY_FILE = "bubble_file";
    private static final String KEY_CLIP = "bubble_clip";
    private static final String KEY_CLIP_AT = "bubble_clip_at";
    private static final String KEY_BUBBLE_X = "bubble_x";
    private static final String KEY_BUBBLE_Y = "bubble_y";
    private static FloatingBubbleService instance;

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
    private boolean longPressFired;
    private boolean panelSuppressPaste;
    private long panelShownAt;
    private boolean panelShowing;
    private long downAt;
    private WebView claudeCodeView;

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

    public static void applyConfig(Context ctx) {
        final FloatingBubbleService s = instance;
        if (s == null || s.bubbleView == null || s.windowManager == null) return;
        new Handler(Looper.getMainLooper()).post(new Runnable() {
            @Override public void run() { s.refreshBubbleConfig(); }
        });
    }

private String claudeCodeHtml(String color) {
        String c = color != null ? color : "#000000";
        String safe = c.replace("\"","").replace("'","").replace("<","").replace(">","");
        return "<html><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><style>html,body{margin:0;background:transparent;overflow:hidden;width:100%;height:100%}#a{width:100%;height:100%;display:grid;place-items:center}</style></head><body><div id=\"a\" style=\"color:" + safe + ";width:100%;height:100%;display:grid;place-items:center\"><svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 3 16 13\" width=\"100%\" height=\"100%\" style=\"display:block\"><defs><style>.action-body{transform-origin:7.5px 13px;animation:action-body 16s infinite ease-in-out}.breathe-anim{transform-origin:7.5px 13px;animation:breathe 3.2s infinite ease-in-out}.shadow-anim{transform-origin:7.5px 15.5px;animation:shadow-action 16s infinite ease-in-out}.arm-l{transform-origin:1px 10px;animation:arm-l-idle 16s infinite ease-in-out}.arm-r{transform-origin:14px 10px;animation:arm-r-idle 16s infinite ease-in-out}.eyes-look{animation:eye-track 16s infinite ease-in-out}.eyes-blink{transform-origin:7.5px 9px;animation:eye-blink 16s infinite linear}.yawn-mouth{transform-origin:7.5px 11px;animation:yawn-mouth-anim 16s infinite ease-in-out;opacity:0}.yawn-tear{animation:tear-fall 16s infinite ease-in-out;opacity:0}@keyframes breathe{0%,100%{transform:scale(1,1) translate(0,0)}50%{transform:scale(1.02,0.98) translate(0,0.5px)}}@keyframes action-body{0%,8%,26%,38%,55%,80%,100%{transform:scale(1,1) translate(0,0)}12%,22%{transform:scale(1,1) translate(1px,0)}42%,50%{transform:scale(1,1) translate(-1px,0)}30%,36%{transform:scale(1,1) translate(0.5px,0)}60%{transform:scale(0.95,1.05) translate(0px,-1px)}65%{transform:scale(0.9,1.1) translate(0px,-2px)}72%{transform:scale(1.05,0.95) translate(0px,1px)}76%{transform:scale(1,1) translate(0px,0px)}}@keyframes shadow-action{0%,8%,26%,38%,55%,80%,100%{transform:scaleX(1) translate(0,0);opacity:0.5}12%,22%{transform:scaleX(1) translate(1px,0);opacity:0.5}42%,50%{transform:scaleX(1) translate(-1px,0);opacity:0.5}30%,36%{transform:scaleX(1) translate(0.5px,0);opacity:0.5}60%{transform:scaleX(0.95) translate(0,0);opacity:0.45}65%{transform:scaleX(0.9) translate(0,0);opacity:0.4}72%{transform:scaleX(1.05) translate(0,0);opacity:0.55}76%{transform:scaleX(1) translate(0,0);opacity:0.5}}@keyframes eye-track{0%,10%,25%,38%,52%,58%,80%,100%{transform:translate(0px,0px)}12%,22%{transform:translate(3px,0px)}42%,50%{transform:translate(-3px,0px)}60%,75%{transform:translate(0px,-1px)}}@keyframes eye-blink{0%,3%,7%,18%,22%,43%,47%,56%,83%,87%,100%{transform:scaleY(1)}5%,20%,45%,85%{transform:scaleY(0.1)}60%{transform:scaleY(1)}62%,72%{transform:scaleY(0.1)}75%{transform:scaleY(1)}}@keyframes arm-l-idle{0%,28%{transform:translate(0,0) rotate(0deg)}30%{transform:translate(1px,-3px) rotate(15deg)}31%{transform:translate(1.5px,-4px) rotate(35deg)}32%{transform:translate(0.5px,-2.5px) rotate(0deg)}33%{transform:translate(1.5px,-4px) rotate(35deg)}34%{transform:translate(0.5px,-2.5px) rotate(0deg)}35%{transform:translate(1.5px,-4px) rotate(35deg)}36%{transform:translate(0.5px,-2.5px) rotate(0deg)}38%,58%{transform:translate(0,0) rotate(0deg)}62%{transform:translate(-1px,-2px) rotate(45deg)}65%{transform:translate(-2px,-3px) rotate(80deg)}72%{transform:translate(0px,1px) rotate(-15deg)}76%,100%{transform:translate(0,0) rotate(0deg)}}@keyframes arm-r-idle{0%,58%{transform:translate(0,0) rotate(0deg)}62%{transform:translate(1px,-2px) rotate(-45deg)}65%{transform:translate(2px,-3px) rotate(-80deg)}72%{transform:translate(0px,1px) rotate(15deg)}76%,100%{transform:translate(0,0) rotate(0deg)}}@keyframes yawn-mouth-anim{0%,58%,76%,100%{opacity:0;transform:scale(0.1)}60%{opacity:1;transform:scale(0.5,0.2)}65%{opacity:1;transform:scale(1.1,1.4)}72%{opacity:1;transform:scale(0.6,0.4)}75%{opacity:0;transform:scale(0.1)}}@keyframes tear-fall{0%,64%,80%,100%{opacity:0;transform:translateY(0)}66%{opacity:1;transform:translateY(0)}72%{opacity:1;transform:translateY(2.5px)}75%{opacity:0;transform:translateY(3px)}}</style></defs><rect class=\"shadow-anim\" x=\"3\" y=\"15\" width=\"9\" height=\"1\" fill=\"#000000\" opacity=\"0.5\"/><g fill=\"currentColor\"><rect x=\"3\" y=\"13\" width=\"1\" height=\"2\"/><rect x=\"5\" y=\"13\" width=\"1\" height=\"2\"/><rect x=\"9\" y=\"13\" width=\"1\" height=\"2\"/><rect x=\"11\" y=\"13\" width=\"1\" height=\"2\"/></g><g class=\"action-body\"><g class=\"breathe-anim\"><rect x=\"2\" y=\"6\" width=\"11\" height=\"7\" fill=\"currentColor\"/><g class=\"arm-l\"><rect x=\"0\" y=\"9\" width=\"2\" height=\"2\" fill=\"currentColor\"/></g><g class=\"arm-r\"><rect x=\"13\" y=\"9\" width=\"2\" height=\"2\" fill=\"currentColor\"/></g><rect class=\"yawn-mouth\" x=\"6\" y=\"10\" width=\"3\" height=\"2\" fill=\"#000\"/><g class=\"eyes-look\" fill=\"#000\"><g class=\"eyes-blink\"><rect x=\"4\" y=\"8\" width=\"1\" height=\"2\"/><rect x=\"10\" y=\"8\" width=\"1\" height=\"2\"/></g></g><rect class=\"yawn-tear\" x=\"3.5\" y=\"10\" width=\"1\" height=\"1\" fill=\"#40C4FF\"/></g></g></svg></div></body></html>";
    }
    private String claudeCodeHtml() { return claudeCodeHtml("#000000"); }
    private View buildClaudeFace(int iconPx, int col) {
        FrameLayout wrap = new FrameLayout(this);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(col);
        bg.setCornerRadius(iconPx * 230f / 1024f);
        wrap.setBackground(bg);
        FrameLayout.LayoutParams wlp = new FrameLayout.LayoutParams(iconPx, iconPx, Gravity.CENTER);
        wrap.setLayoutParams(wlp);
        wrap.setClipChildren(false);
        int eyeW = Math.round(iconPx * 120f / 1024f);
        int eyeH = Math.round(iconPx * 240f / 1024f);
        int eyeR = Math.round(iconPx * 20f / 1024f);
        int hlW = Math.round(iconPx * 40f / 1024f);
        int hlH = Math.round(iconPx * 60f / 1024f);
        int hlR = Math.round(iconPx * 10f / 1024f);
        int lx = Math.round(iconPx * 250f / 1024f);
        int ly = Math.round(iconPx * 350f / 1024f);
        int rx = Math.round(iconPx * 650f / 1024f);
        int hlLx = Math.round(iconPx * 270f / 1024f);
        int hlLy = Math.round(iconPx * 380f / 1024f);
        int hlRx = Math.round(iconPx * 670f / 1024f);
        View eyeL = new View(this);
        GradientDrawable dL = new GradientDrawable(); dL.setColor(0xFF111111); dL.setCornerRadius(eyeR); eyeL.setBackground(dL);
        FrameLayout.LayoutParams lpL = new FrameLayout.LayoutParams(eyeW, eyeH); lpL.gravity = Gravity.TOP | Gravity.START; lpL.leftMargin = lx; lpL.topMargin = ly; eyeL.setLayoutParams(lpL); wrap.addView(eyeL);
        View eyeR2 = new View(this);
        GradientDrawable dR = new GradientDrawable(); dR.setColor(0xFF111111); dR.setCornerRadius(eyeR); eyeR2.setBackground(dR);
        FrameLayout.LayoutParams lpR = new FrameLayout.LayoutParams(eyeW, eyeH); lpR.gravity = Gravity.TOP | Gravity.START; lpR.leftMargin = rx; lpR.topMargin = ly; eyeR2.setLayoutParams(lpR); wrap.addView(eyeR2);
        View hlL = new View(this);
        GradientDrawable dHL = new GradientDrawable(); dHL.setColor(0xFFFFFFFF); dHL.setCornerRadius(hlR); hlL.setBackground(dHL);
        FrameLayout.LayoutParams lpHL = new FrameLayout.LayoutParams(hlW, hlH); lpHL.gravity = Gravity.TOP | Gravity.START; lpHL.leftMargin = hlLx; lpHL.topMargin = hlLy; hlL.setLayoutParams(lpHL); wrap.addView(hlL);
        View hlR2 = new View(this);
        GradientDrawable dHR = new GradientDrawable(); dHR.setColor(0xFFFFFFFF); dHR.setCornerRadius(hlR); hlR2.setBackground(dHR);
        FrameLayout.LayoutParams lpHR = new FrameLayout.LayoutParams(hlW, hlH); lpHR.gravity = Gravity.TOP | Gravity.START; lpHR.leftMargin = hlRx; lpHR.topMargin = hlLy; hlR2.setLayoutParams(lpHR); wrap.addView(hlR2);
        return wrap;
    }
    private View buildPacmanFace(int iconPx, int col) {
        FrameLayout wrap = new FrameLayout(this);
        FrameLayout.LayoutParams wlp = new FrameLayout.LayoutParams(iconPx, iconPx, Gravity.CENTER);
        wrap.setLayoutParams(wlp);
        ImageView iv = new ImageView(this);
        iv.setImageResource(R.drawable.bubble_pacman);
        try { iv.setColorFilter(col, PorterDuff.Mode.SRC_IN); } catch (Exception ignored) {}
        FrameLayout.LayoutParams ilp = new FrameLayout.LayoutParams(iconPx, iconPx, Gravity.CENTER);
        iv.setLayoutParams(ilp);
        wrap.addView(iv);
        // eye overlay to preserve black eye + white highlight (tint would otherwise monochrome it)
        int eyeSize = Math.round(iconPx * 24f / 300f);
        int eyeR = eyeSize/2;
        int hlSize = Math.round(iconPx * 7f / 300f);
        int eyeX = Math.round(iconPx * 180f / 300f - eyeSize/2);
        int eyeY = Math.round(iconPx * 110f / 300f - eyeSize/2);
        int hlX = Math.round(iconPx * 183f / 300f - hlSize/2);
        int hlY = Math.round(iconPx * 106f / 300f - hlSize/2);
        View eye = new View(this);
        GradientDrawable d = new GradientDrawable(); d.setColor(0xFF000000); d.setCornerRadius(eyeR); eye.setBackground(d);
        FrameLayout.LayoutParams lpEye = new FrameLayout.LayoutParams(eyeSize, eyeSize); lpEye.gravity = Gravity.TOP|Gravity.START; lpEye.leftMargin = eyeX; lpEye.topMargin = eyeY; eye.setLayoutParams(lpEye); wrap.addView(eye);
        View hl = new View(this);
        GradientDrawable d2 = new GradientDrawable(); d2.setColor(0xFFFFFFFF); d2.setCornerRadius(hlSize/2f); hl.setBackground(d2);
        FrameLayout.LayoutParams lpHl = new FrameLayout.LayoutParams(hlSize, hlSize); lpHl.gravity = Gravity.TOP|Gravity.START; lpHl.leftMargin = hlX; lpHl.topMargin = hlY; hl.setLayoutParams(lpHl); wrap.addView(hl);
        // make overlay eyes non-clickable so touch passes to parent
        eye.setClickable(false); hl.setClickable(false);
        return wrap;
    }
    private void playClaudeCode(String name, int revertMs) {
        try { if (claudeCodeView != null) claudeCodeView.evaluateJavascript("window.playClaude('" + name + "'," + revertMs + ")", null); } catch (Exception ignored) {}
    }
    private void refreshBubbleConfig() {
        try {
            SharedPreferences p = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
            String icon = p.getString("bubble_icon", "claudeCodePlayful");
            String color = p.getString("bubble_color", "#ef4444");
            int sz = p.getInt("bubble_size", 60);
            int col = Color.parseColor(color);
            int margin = dp(32);
            int winSize = dp(sz) + margin * 2;
            int iconPx = dp(sz * 0.95f);
            if (bubbleView instanceof FrameLayout) {
                FrameLayout root = (FrameLayout) bubbleView;
                if (claudeCodeView != null) { try { claudeCodeView.destroy(); } catch (Exception ignored) {} claudeCodeView = null; }
                root.removeAllViews();
                // Website-driven bubble: single WebView loads /bubble-icon.html?icon=&color= — future icons need only website update
                WebView wv = new WebView(this);
                wv.setBackgroundColor(Color.TRANSPARENT);
                try { wv.setLayerType(View.LAYER_TYPE_SOFTWARE, null); } catch (Exception ignored) {}
                WebSettings ws = wv.getSettings();
                ws.setJavaScriptEnabled(true);
                wv.setVerticalScrollBarEnabled(false);
                wv.setHorizontalScrollBarEnabled(false);
                wv.setClickable(false);
                wv.setFocusable(false);
                wv.setFocusableInTouchMode(false);
                wv.setOnTouchListener(new View.OnTouchListener(){ @Override public boolean onTouch(View v, MotionEvent e){ if (bubbleView != null) bubbleTouchListener.onTouch(bubbleView, e); return true; }});
                FrameLayout.LayoutParams wlp = new FrameLayout.LayoutParams(winSize, winSize, Gravity.CENTER);
                wv.setLayoutParams(wlp);
                String encIcon = Uri.encode(icon);
                String encColor = Uri.encode(color);
                int boxPct = Math.round(iconPx * 100f / winSize);
                wv.loadUrl(Config.HOME_URL + "/bubble-icon.html?icon=" + encIcon + "&color=" + encColor + "&box=" + boxPct);
                claudeCodeView = wv;
                root.addView(wv);
            }
            bubbleParams.width = winSize;
            bubbleParams.height = winSize;
            bubbleParams.x = clamp(bubbleParams.x, 0, Math.max(0, displayWidth() - winSize));
            bubbleParams.y = clamp(bubbleParams.y, 0, Math.max(0, displayHeight() - winSize));
            windowManager.updateViewLayout(bubbleView, bubbleParams);
        } catch (Exception e) { Log.e(TAG, "refreshBubbleConfig: " + e.getMessage()); }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
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
        // Preload the selected file's mini-window page now (right after the
        // bubble is enabled) instead of lazily on the first tap — the panel
        // then shows the already-loaded sheet when the user opens it.
        ensureMiniWebView();
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
        SharedPreferences cfg = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        String cfgIcon = cfg.getString("bubble_icon", "claudeCodePlayful");
        String cfgColor = cfg.getString("bubble_color", "#ef4444");
        int cfgSize = cfg.getInt("bubble_size", 60);
        int size = dp(cfgSize);
        int margin = dp(32);
        int windowSize = size + margin * 2;

        FrameLayout root = new FrameLayout(this);
        root.setClipChildren(false);
        root.setClipToPadding(false);

        int iconPx = dp(cfgSize * 0.95f);
        // Website-driven bubble — single WebView for all icons (website decides SVG)
        WebView wv = new WebView(this);
        wv.setBackgroundColor(Color.TRANSPARENT);
        try { wv.setLayerType(View.LAYER_TYPE_SOFTWARE, null); } catch (Exception ignored) {}
        WebSettings ws = wv.getSettings();
        ws.setJavaScriptEnabled(true);
        wv.setVerticalScrollBarEnabled(false);
        wv.setHorizontalScrollBarEnabled(false);
        wv.setClickable(false);
        wv.setFocusable(false);
        wv.setFocusableInTouchMode(false);
        wv.setOnTouchListener(new View.OnTouchListener(){ @Override public boolean onTouch(View v, MotionEvent e){ if (bubbleView != null) bubbleTouchListener.onTouch(bubbleView, e); return true; }});
        // The WebView fills the whole window (icon + reserved margin) instead of
        // just the icon box — the animated SVGs intentionally scale/translate
        // past their rest size, and a WebView clips its own canvas at its view
        // bounds. Sizing it to iconPx only (old behavior) hard-cropped every
        // frame that reached past the icon's resting box. `box` tells the page
        // what percent of this now-larger canvas the icon should occupy at rest
        // so it still looks the same size, with real headroom around it.
        FrameLayout.LayoutParams wlp = new FrameLayout.LayoutParams(windowSize, windowSize, Gravity.CENTER);
        wv.setLayoutParams(wlp);
        int boxPct = Math.round(iconPx * 100f / windowSize);
        wv.loadUrl(Config.HOME_URL + "/bubble-icon.html?icon=" + Uri.encode(cfgIcon) + "&color=" + Uri.encode(cfgColor) + "&box=" + boxPct);
        claudeCodeView = wv;
        root.addView(wv);

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

    private void hapticFeedback() {
        try {
            if (bubbleView != null) {
                bubbleView.performHapticFeedback(
                        HapticFeedbackConstants.LONG_PRESS,
                        HapticFeedbackConstants.FLAG_IGNORE_VIEW_SETTING);
            }
        } catch (Exception ignored) {}
        // Fallback for devices/overlays where performHapticFeedback is a no-op
        // (FLAG_NOT_FOCUSABLE windows often swallow haptics).
        try {
            Vibrator vib = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            if (vib != null && vib.hasVibrator()) {
                if (Build.VERSION.SDK_INT >= 26) {
                    vib.vibrate(VibrationEffect.createOneShot(30, VibrationEffect.DEFAULT_AMPLITUDE));
                } else {
                    vib.vibrate(30);
                }
            }
        } catch (Exception ignored) {}
    }

    private final Runnable longPressRunnable = new Runnable() {
        @Override
        public void run() {
            // Fired while the finger is STILL DOWN after LONG_PRESS_MS.
            // Long-press = skip 2FA (only applies when the row has a cookie and
            // no key — decided in JS) AND open the mini sheet so the user can
            // see the rows. The panel must NOT capture the clipboard or run
            // paste automation, or it would immediately fill the just-skipped
            // row with an unrelated clip.
            if (bubbleView == null) return;
            longPressFired = true;
            bubbleView.performClick();
            hapticFeedback();
            panelSuppressPaste = true; // panel opens read-only-ish, no paste
            if (miniWebView != null) {
                miniWebView.evaluateJavascript(
                    "window.__ss&&window.__ss.bubbleSkipNo2FA&&window.__ss.bubbleSkipNo2FA();", null);
            }
            if (!panelShowing) showPanel();
        }
    };

    private void cancelLongPress() {
        bubbleView.removeCallbacks(longPressRunnable);
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
                    longPressFired = false;
                    downAt = SystemClock.elapsedRealtime();
                    v.animate().scaleX(0.92f).scaleY(0.92f).setDuration(120).start();
                    // Arm the long-press NOW — it fires after LONG_PRESS_MS while
                    // still held, not on release.
                    v.postDelayed(longPressRunnable, LONG_PRESS_MS);
                    return true;
                case MotionEvent.ACTION_MOVE:
                    if (Math.abs(ev.getRawX() - initialRawX) > touchSlop
                            || Math.abs(ev.getRawY() - initialRawY) > touchSlop) {
                        // A drag is not a long-press — disarm it.
                        cancelLongPress();
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
                    cancelLongPress();
                    v.animate().scaleX(1f).scaleY(1f).setDuration(150).start();
                    getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit()
                            .putInt(KEY_BUBBLE_X, bubbleParams.x)
                            .putInt(KEY_BUBBLE_Y, bubbleParams.y)
                            .apply();
                    if (!dragging && !longPressFired) {
                        // Short tap only — a long-press already ran its skip while
                        // held and consumed this gesture, so release does NOT open
                        // the panel or paste anything.
                        v.performClick();
                        togglePanel();
                    }
                    dragging=false;
                    return true;
                case MotionEvent.ACTION_CANCEL:
                    cancelLongPress();
                    dragging = false;
                    longPressFired = false;
                    v.animate().scaleX(1f).scaleY(1f).setDuration(150).start();
                    return true;
            }
            return false;
        }
    };

    private int clamp(int v, int min, int max) {
        return Math.max(min, Math.min(v, max));
    }
    // hygiene: inset-aware bounds so panel never under status/nav bar — keep 220x280 size, same anim
    private android.graphics.Rect contentBounds() {
        int w = displayWidth(); int h = displayHeight();
        int sb = 0; try { int id = getResources().getIdentifier("status_bar_height","dimen","android"); if(id>0) sb = getResources().getDimensionPixelSize(id); } catch(Exception ignored) {}
        int nb = 0; try { int id = getResources().getIdentifier("navigation_bar_height","dimen","android"); if(id>0) nb = getResources().getDimensionPixelSize(id); } catch(Exception ignored) {}
        return new android.graphics.Rect(0, sb, w, h - nb);
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
            android.graphics.Rect cb = contentBounds();
            int scrW = cb.width(); int scrH = cb.height();
            int panelW = Math.min(dp(220), Math.max(200, scrW - dp(20)));
            panelW = Math.min(panelW, scrW - dp(8));
            int panelH = Math.min(dp(280), Math.max(240, scrH - dp(40)));
            panelH = Math.min(panelH, scrH - dp(16));

            panelRoot = new FrameLayout(this);

            LinearLayout card = new LinearLayout(this);
            card.setOrientation(LinearLayout.VERTICAL);
            GradientDrawable cardBg = new GradientDrawable();
            cardBg.setColor(0xFFFFFFFF);
            cardBg.setCornerRadius(dp(16));
            cardBg.setStroke(dp(1), 0xFFE4E4E7);
            card.setBackground(cardBg);
            card.setClipToOutline(true);
            FrameLayout.LayoutParams cardParams = new FrameLayout.LayoutParams(panelW, panelH, Gravity.TOP | Gravity.START);
            int bx = bubbleParams.x + bubbleParams.width / 2;
            int by = bubbleParams.y + bubbleParams.height / 2;
            int gap = dp(8);
            int left, top;
            // use cb inset so panel never under status/nav bar — same 220x280, same anim
            if (cb.right - bx >= panelW + gap) {
                left = bx + gap;
                top = clamp(by - panelH / 2, cb.top + dp(8), Math.max(cb.top + dp(8), cb.bottom - panelH - dp(8)));
            } else if (bx - cb.left >= panelW + gap) {
                left = bx - panelW - gap;
                top = clamp(by - panelH / 2, cb.top + dp(8), Math.max(cb.top + dp(8), cb.bottom - panelH - dp(8)));
            } else if (cb.bottom - by >= panelH + gap) {
                left = clamp(bx - panelW / 2, cb.left + dp(8), Math.max(cb.left + dp(8), cb.right - panelW - dp(8)));
                top = by + gap;
            } else {
                left = clamp(bx - panelW / 2, cb.left + dp(8), Math.max(cb.left + dp(8), cb.right - panelW - dp(8)));
                top = by - panelH - gap;
            }
            cardParams.leftMargin = left;
            cardParams.topMargin = top;
            card.setLayoutParams(cardParams);

            ensureMiniWebView();
            if (miniWebView != null) {
                ViewGroup oldParent = (ViewGroup) miniWebView.getParent();
                if (oldParent != null) oldParent.removeView(miniWebView);
                LinearLayout.LayoutParams wlp = new LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f);
                card.addView(miniWebView, wlp);
                miniWebView.onResume();
                panelRoot.requestFocus();
                if (miniWebView != null) miniWebView.requestFocus();
                if (!panelSuppressPaste) {
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
                                    miniWebView.evaluateJavascript("window.__ss&&window.__ss.bubbleAutomate&&window.__ss.bubbleAutomate();", null);
                                } catch (Exception ignored) {}
                            } else {
                                panelRoot.postDelayed(this, 200);
                            }
                        }
                    };
                    panelRoot.postDelayed(pollRunnable, 200);
                }
            }

            panelRoot.addView(card);
            card.setAlpha(0f);
            card.setScaleX(0.9f);
            card.setScaleY(0.9f);
            card.animate().alpha(1f).scaleX(1f).scaleY(1f)
                    .setDuration(120).setInterpolator(new AccelerateDecelerateInterpolator()).start();
            panelRoot.setOnTouchListener(new View.OnTouchListener() {
                @Override
                public boolean onTouch(View v, MotionEvent event) {
                    if (event.getActionMasked() == MotionEvent.ACTION_DOWN
                            && SystemClock.elapsedRealtime() - panelShownAt > 350) {
                        hidePanel();
                        return true;
                    }
                    return false;
                }
            });
            card.setClickable(true);

            WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                    WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT,
                    overlayType(), WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE, PixelFormat.TRANSLUCENT);
            lp.gravity = Gravity.TOP | Gravity.START;
            lp.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE;
            windowManager.addView(panelRoot, lp);
            panelShownAt = SystemClock.elapsedRealtime();
            if (!panelSuppressPaste) {
                // Attach the overlay before transferring focus so the activity cannot
                // expose the app task for a frame during a tap.
                try {
                    Intent cap = new Intent(this, ClipboardCaptureActivity.class);
                    cap.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION);
                    startActivity(cap, ActivityOptions.makeCustomAnimation(this, 0, 0).toBundle());
                } catch (Exception e) {
                    Log.w(TAG, "ClipboardCaptureActivity failed, using fallback", e);
                    try {
                        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                        if (cm != null && cm.hasPrimaryClip() && cm.getPrimaryClip() != null && cm.getPrimaryClip().getItemCount() > 0) {
                            CharSequence cs = cm.getPrimaryClip().getItemAt(0).getText();
                            String text = cs != null ? cs.toString() : "";
                            getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit()
                                    .putString(KEY_CLIP, text)
                                    .putLong(KEY_CLIP_AT, System.currentTimeMillis())
                                    .apply();
                        }
                    } catch (Exception ignored) {}
                }
            }
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
            // Keep the already-loaded page alive — never recreate on reopen.
            // It is only destroyed in onDestroy() (app close / bubble disabled).
            return;
        }
        try {
            miniWebView = new WebView(this);
            miniWebView.setBackgroundColor(0x00000000);
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
                String url = Config.HOME_URL + "/?bubble=1&file=" + Uri.encode(fileId);
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
            // Keep the page rendered — only pause JS timers while hidden.
            // The WebView itself stays alive until the app closes or the
            // bubble is disabled, so the sheet is shown instantly next time.
            try { miniWebView.onPause(); } catch (Exception ignored) {}
        }
        if (panelRoot != null) {
            try { windowManager.removeView(panelRoot); } catch (Exception ignored) {}
            panelRoot = null;
        }
        // MUST reset — otherwise togglePanel() never opens the panel again
        // after the first close (panelShowing remains true forever).
        panelShowing = false;
        // Clear the long-press "no paste" flag — the next TAP opens a normal
        // panel that captures the clipboard and auto-pastes again.
        panelSuppressPaste = false;
        // event-specific: long animation holds while popup open, revert to idle when closed
        playClaudeCode("idle",0);
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
                .setSmallIcon(R.drawable.bubble_icon)
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
        if (instance == this) instance = null;
        hidePanel();
        if (miniWebView != null) {
            miniWebView.destroy();
            miniWebView = null;
        }
        if (bubbleView != null) {
            try { windowManager.removeView(bubbleView); } catch (Exception ignored) {}
            bubbleView = null;
        }
        if (claudeCodeView != null) { try { claudeCodeView.destroy(); } catch (Exception ignored) {} claudeCodeView = null; }
        super.onDestroy();
    }
}
