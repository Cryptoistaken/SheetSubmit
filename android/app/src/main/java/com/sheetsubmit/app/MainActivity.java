package com.sheetsubmit.app;

import android.app.Activity;
import android.app.DownloadManager;
import android.Manifest;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.provider.Settings;
import android.util.Log;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.UUID;

public class MainActivity extends Activity {

    private static final String HOME_URL = "https://sheetsubmit.up.railway.app";
    private static final String APP_HOST = "sheetsubmit.up.railway.app";
    private static final String PREFS_NAME = "sheetsubmit";
    private static final String TAG = "SheetSubmit";
    private static final int REQ_OVERLAY_PERMISSION = 2001;
    private static final int REQ_NOTIFICATION_PERMISSION = 2002;

    private WebView webView;
    private String did;
    private boolean sessionApplied = false;
    private final Handler pollHandler = new Handler(Looper.getMainLooper());
    private ValueCallback<Uri[]> filePathCallback;
    private static final int REQ_FILE_CHOOSER = 2003;

    private final Runnable pollRunnable = new Runnable() {
        @Override
        public void run() {
            checkDeviceLogin();
            if (!sessionApplied) {
                pollHandler.postDelayed(this, 4000);
            }
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        did = getDeviceToken();

        webView = new WebView(this);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setUserAgentString(s.getUserAgentString().replace("; wv", ""));

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (url == null) return false;
                Uri u = Uri.parse(url);
                String scheme = u.getScheme() == null ? "" : u.getScheme();
                String host = u.getHost() == null ? "" : u.getHost();

                if (scheme.equals("tg") || host.equals("t.me") || host.equals("telegram.me")) {
                    String newUrl = url;
                    if (newUrl.contains("start=login") && !newUrl.contains("login_")) {
                        newUrl = newUrl.replace("start=login", "start=login_" + did);
                    }
                    openExternal(newUrl);
                    return true;
                }
                if (host.equals(APP_HOST)) {
                    view.loadUrl(url);
                    return true;
                }
                openExternal(url);
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                injectClipboardBridge();
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
                WebView popup = new WebView(view.getContext());
                popup.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView v, String url) {
                        v.loadUrl(url);
                        return true;
                    }
                });
                WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
                transport.setWebView(popup);
                resultMsg.sendToTarget();
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
                if (MainActivity.this.filePathCallback != null) {
                    MainActivity.this.filePathCallback.onReceiveValue(null);
                }
                MainActivity.this.filePathCallback = filePathCallback;
                try {
                    Intent intent = fileChooserParams.createIntent();
                    startActivityForResult(intent, REQ_FILE_CHOOSER);
                    return true;
                } catch (Exception e) {
                    MainActivity.this.filePathCallback = null;
                    return false;
                }
            }
        });

        webView.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimetype, long contentLength) {
                String name = url.substring(url.lastIndexOf('/') + 1);
                if (name.isEmpty() || name.contains("?")) name = "download.xlsx";
                DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                req.setTitle(name);
                req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                dm.enqueue(req);
            }
        });

        CookieManager.getInstance().setAcceptCookie(true);

        webView.addJavascriptInterface(new Object() {
            @JavascriptInterface
            public String readClipboard() {
                try {
                    ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                    if (cm != null && cm.hasPrimaryClip() && cm.getPrimaryClip() != null && cm.getPrimaryClip().getItemCount() > 0) {
                        CharSequence cs = cm.getPrimaryClip().getItemAt(0).getText();
                        return cs != null ? cs.toString() : "";
                    }
                } catch (Exception e) { Log.e(TAG, "readClipboard: " + e.getMessage()); }
                return "";
            }

            @JavascriptInterface
            public void writeClipboard(String text) {
                try {
                    ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                    if (cm != null) {
                        cm.setPrimaryClip(ClipData.newPlainText("sheetsubmit", text == null ? "" : text));
                    }
                } catch (Exception e) { Log.e(TAG, "writeClipboard: " + e.getMessage()); }
            }

            @JavascriptInterface
            public boolean isBubbleEnabled() {
                SharedPreferences p = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                return p.getString("bubble_file", null) != null;
            }

            @JavascriptInterface
            public void enableBubble(String fileId) {
                final String fid = fileId == null ? "" : fileId;
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        requestEnableBubble(fid);
                    }
                });
            }

            @JavascriptInterface
            public void disableBubble() {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                                .edit().remove("bubble_file").apply();
                        FloatingBubbleService.stop(MainActivity.this);
                    }
                });
            }

            @JavascriptInterface
            public String getBubbleFile() {
                return getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getString("bubble_file", "");
            }
        }, "Android");

        webView.loadUrl(HOME_URL);
        pollHandler.post(pollRunnable);

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(this)) {
            if (getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getString("bubble_file", null) != null) {
                FloatingBubbleService.start(this);
            }
        }
    }

    private void injectClipboardBridge() {
        String shim = "(function(){" +
            "if(window.Android&&window.Android.readClipboard&&window.Android.writeClipboard){" +
            "navigator.clipboard.readText=function(){return new Promise(function(res,rej){try{res(window.Android.readClipboard());}catch(e){rej(e);}});};" +
            "navigator.clipboard.writeText=function(t){window.Android.writeClipboard(String(t));return Promise.resolve();};" +
            "navigator.clipboard.read=function(){return Promise.reject(new Error('not supported'));};" +
            "window.nativeClipboardReady=true;}" +
            "})();";
        webView.evaluateJavascript(shim, null);
    }

    private String getDeviceToken() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        String id = prefs.getString("did", "");
        if (id.isEmpty()) {
            id = UUID.randomUUID().toString().replace("-", "");
            prefs.edit().putString("did", id).apply();
            Log.d(TAG, "Generated device id");
        }
        return id;
    }

    private void checkDeviceLogin() {
        final String pollUrl = HOME_URL + "/api/auth/device?token=" + did;
        new Thread(new Runnable() {
            @Override
            public void run() {
                HttpURLConnection conn = null;
                try {
                    URL u = new URL(pollUrl);
                    conn = (HttpURLConnection) u.openConnection();
                    conn.setConnectTimeout(5000);
                    conn.setReadTimeout(5000);
                    conn.setRequestMethod("GET");
                    int code = conn.getResponseCode();
                    if (code != 200) return;
                    InputStream is = conn.getInputStream();
                    BufferedReader reader = new BufferedReader(new InputStreamReader(is));
                    StringBuilder sb = new StringBuilder();
                    String line;
                    while ((line = reader.readLine()) != null) sb.append(line);
                    JSONObject json = new JSONObject(sb.toString());
                    if (json.optBoolean("ok") && json.has("sessionId")) {
                        final String sessionId = json.getString("sessionId");
                        runOnUiThread(new Runnable() {
                            @Override
                            public void run() {
                                applySession(sessionId);
                            }
                        });
                    }
                } catch (Exception e) {
                    // transient; retry on next poll
                } finally {
                    if (conn != null) conn.disconnect();
                }
            }
        }).start();
    }

    private void applySession(String sessionId) {
        if (sessionApplied) return;
        sessionApplied = true;
        String cookie = "session=" + sessionId + "; Path=/; HttpOnly; Max-Age=2592000";
        CookieManager cm = CookieManager.getInstance();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            cm.setCookie(HOME_URL, cookie, new ValueCallback<Boolean>() {
                @Override
                public void onReceiveValue(Boolean value) {
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            if (webView != null) webView.loadUrl(HOME_URL);
                        }
                    });
                }
            });
        } else {
            cm.setCookie(HOME_URL, cookie);
            if (webView != null) webView.loadUrl(HOME_URL);
        }
        Log.d(TAG, "Session applied via device login");
    }

    private void openExternal(String url) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            startActivity(intent);
        } catch (Exception e) {
            if (webView != null) webView.loadUrl(url);
        }
    }

    private void requestEnableBubble(String fileId) {
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                .edit().putString("bubble_file", fileId).apply();
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFICATION_PERMISSION);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(this)) {
            try {
                Intent intent = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        Uri.parse("package:" + getPackageName()));
                startActivityForResult(intent, REQ_OVERLAY_PERMISSION);
            } catch (Exception e) {
                FloatingBubbleService.start(this);
            }
            return;
        }
        FloatingBubbleService.start(this);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_OVERLAY_PERMISSION) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(this)) {
                FloatingBubbleService.start(this);
            }
        }
        if (requestCode == REQ_FILE_CHOOSER) {
            Uri[] results = null;
            if (resultCode == Activity.RESULT_OK && data != null) {
                String dataString = data.getDataString();
                if (dataString != null) {
                    results = new Uri[]{Uri.parse(dataString)};
                }
                if (data.getClipData() != null) {
                    int count = data.getClipData().getItemCount();
                    results = new Uri[count];
                    for (int i = 0; i < count; i++) {
                        results[i] = data.getClipData().getItemAt(i).getUri();
                    }
                }
            }
            if (filePathCallback != null) {
                filePathCallback.onReceiveValue(results);
                filePathCallback = null;
            }
        }
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        pollHandler.removeCallbacks(pollRunnable);
        webView.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (!sessionApplied) {
            pollHandler.removeCallbacks(pollRunnable);
            pollHandler.post(pollRunnable);
        }
        webView.onResume();
    }

    @Override
    protected void onDestroy() {
        pollHandler.removeCallbacks(pollRunnable);
        webView.destroy();
        super.onDestroy();
    }
}
