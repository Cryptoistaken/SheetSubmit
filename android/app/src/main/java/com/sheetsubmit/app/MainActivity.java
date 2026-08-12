package com.sheetsubmit.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.Manifest;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.DialogInterface;
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
import android.widget.Toast;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
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

            @JavascriptInterface
            public void checkForUpdates() {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        Toast.makeText(MainActivity.this, "Checking for updates…", Toast.LENGTH_SHORT).show();
                    }
                });
                fetchLatestRelease(new ReleaseListener() {
                    @Override
                    public void onResult(final JSONObject json) {
                        final String tag = json.optString("tag_name");
                        if (!tag.matches("v\\d+")) return;
                        try {
                            int installed = getPackageManager().getPackageInfo(getPackageName(), 0).versionCode;
                            if (Integer.parseInt(tag.substring(1)) <= installed) {
                                runOnUiThread(new Runnable() {
                                    @Override
                                    public void run() {
                                        Toast.makeText(MainActivity.this, "You're up to date (v" + tag + ")", Toast.LENGTH_SHORT).show();
                                    }
                                });
                                return;
                            }
                            JSONObject asset = json.getJSONArray("assets").optJSONObject(0);
                            if (asset == null) return;
                            final String apkUrl = asset.getString("browser_download_url");
                            final long mb = asset.getLong("size") / (1024L * 1024L);
                            final String body = json.optString("body", "").trim();
                            runOnUiThread(new Runnable() {
                                @Override
                                public void run() {
                                    AlertDialog.Builder b = new AlertDialog.Builder(MainActivity.this);
                                    b.setTitle("Update available");
                                    String msg = "v" + tag + " · " + mb + " MB — install over the current version, data preserved";
                                    if (!body.isEmpty()) {
                                        msg += "\n\n" + body;
                                    }
                                    b.setMessage(msg);
                                    b.setPositiveButton("Update", new DialogInterface.OnClickListener() {
                                        @Override
                                        public void onClick(DialogInterface d, int which) {
                                            downloadUpdate(apkUrl);
                                        }
                                    });
                                    b.setNegativeButton("Later", null);
                                    b.show();
                                }
                            });
                        } catch (Exception e) {
                            Log.e(TAG, "checkForUpdates: " + e.getMessage());
                        }
                    }

                    @Override
                    public void onError() {
                        // silent — keep pre-existing behavior on fetch failure
                    }
                });
            }

            @JavascriptInterface
            public void whatsNew() {
                fetchLatestRelease(new ReleaseListener() {
                    @Override
                    public void onResult(final JSONObject json) {
                        final String tag = json.optString("tag_name");
                        final String body = json.optString("body", "").trim();
                        runOnUiThread(new Runnable() {
                            @Override
                            public void run() {
                                if (tag.isEmpty()) {
                                    Toast.makeText(MainActivity.this, R.string.whats_new_error, Toast.LENGTH_LONG).show();
                                    return;
                                }
                                AlertDialog.Builder b = new AlertDialog.Builder(MainActivity.this);
                                b.setTitle(getString(R.string.whats_new_title) + " in " + tag);
                                b.setMessage(body.isEmpty() ? getString(R.string.whats_new_empty) : body);
                                b.setPositiveButton("OK", null);
                                b.show();
                            }
                        });
                    }

                    @Override
                    public void onError() {
                        runOnUiThread(new Runnable() {
                            @Override
                            public void run() {
                                Toast.makeText(MainActivity.this, R.string.whats_new_error, Toast.LENGTH_LONG).show();
                            }
                        });
                    }
                });
            }
        }, "Android");

    private interface ReleaseListener {
        void onResult(JSONObject release);
        void onError();
    }

    private void fetchLatestRelease(final ReleaseListener listener) {
        final String releasesUrl = "https://api.github.com/repos/Cryptoistaken/SheetSubmit/releases/latest";
        new Thread(new Runnable() {
            @Override
            public void run() {
                HttpURLConnection conn = null;
                try {
                    URL u = new URL(releasesUrl);
                    conn = (HttpURLConnection) u.openConnection();
                    conn.setConnectTimeout(8000);
                    conn.setReadTimeout(8000);
                    conn.setRequestProperty("User-Agent", "SheetSubmit-Updater");
                    conn.setRequestMethod("GET");
                    if (conn.getResponseCode() != 200) {
                        listener.onError();
                        return;
                    }
                    InputStream is = conn.getInputStream();
                    BufferedReader reader = new BufferedReader(new InputStreamReader(is));
                    StringBuilder sb = new StringBuilder();
                    String line;
                    while ((line = reader.readLine()) != null) sb.append(line);
                    listener.onResult(new JSONObject(sb.toString()));
                } catch (Exception e) {
                    Log.e(TAG, "fetchLatestRelease: " + e.getMessage());
                    listener.onError();
                } finally {
                    if (conn != null) conn.disconnect();
                }
            }
        }).start();
    }

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

    private void downloadUpdate(final String apkUrl) {
        final File target = new File(getCacheDir(), "apk/update.apk");
        Toast.makeText(this, "Downloading…", Toast.LENGTH_SHORT).show();
        new Thread(new Runnable() {
            @Override
            public void run() {
                HttpURLConnection conn = null;
                InputStream is = null;
                FileOutputStream fos = null;
                try {
                    URL u = new URL(apkUrl);
                    conn = (HttpURLConnection) u.openConnection();
                    conn.setConnectTimeout(8000);
                    conn.setReadTimeout(8000);
                    conn.setRequestProperty("User-Agent", "SheetSubmit-Updater");
                    conn.setRequestMethod("GET");
                    if (conn.getResponseCode() != 200) throw new IOException("HTTP " + conn.getResponseCode());
                    is = conn.getInputStream();
                    File dir = target.getParentFile();
                    if (dir != null && !dir.exists()) dir.mkdirs();
                    if (target.exists()) target.delete();
                    fos = new FileOutputStream(target);
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = is.read(buf)) != -1) fos.write(buf, 0, n);
                    fos.flush();
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            try {
                                Intent intent = new Intent(Intent.ACTION_VIEW);
                                intent.setDataAndType(ApkProvider.uriFor(MainActivity.this, target), "application/vnd.android.package-archive");
                                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                                startActivity(intent);
                            } catch (Exception e) {
                                Toast.makeText(MainActivity.this, "Cannot open installer", Toast.LENGTH_LONG).show();
                            }
                        }
                    });
                } catch (Exception e) {
                    Log.e(TAG, "update download: " + e.getMessage());
                    final String err = e.getMessage() == null ? "Download failed" : e.getMessage();
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            Toast.makeText(MainActivity.this, err, Toast.LENGTH_LONG).show();
                        }
                    });
                } finally {
                    if (fos != null) {
                        try { fos.close(); } catch (Exception ignored) {}
                    }
                    if (is != null) {
                        try { is.close(); } catch (Exception ignored) {}
                    }
                    if (conn != null) conn.disconnect();
                }
            }
        }).start();
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
