package com.sheetsubmit.app;

import android.app.Activity;
import android.app.Dialog;
import android.app.DownloadManager;
import android.Manifest;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Locale;
import java.util.UUID;

public class MainActivity extends Activity {

    private static final String PREFS_NAME = "sheetsubmit";
    private static final String TAG = "SheetSubmit";
    private static final int REQ_OVERLAY_PERMISSION = 2001;
    private static final int REQ_NOTIFICATION_PERMISSION = 2002;
    private static final int REQ_FILE_CHOOSER = 2003;
    private static final int REQ_UNKNOWN_APP_SOURCES = 2004;
    private static final int UPDATE_RETRIES = 2;
    private static final int DOWNLOAD_CONNECT_TIMEOUT = 30000;
    private static final int DOWNLOAD_READ_TIMEOUT = 60000;

    private WebView webView;
    private String did;
    private boolean sessionApplied = false;
    private volatile boolean destroyed = false;
    private final Handler pollHandler = new Handler(Looper.getMainLooper());
    private ValueCallback<Uri[]> filePathCallback;
    private Dialog progressDialog;
    private Dialog updateDialog;
    private Dialog permissionDialog;
    private ProgressBar progressBar;
    private TextView progressText;
    private String pendingApkUrl;
    private long pendingApkSize;

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
                    // tg:// needs Telegram app; if not installed fallback to https://t.me
                    if (newUrl.startsWith("tg:")) {
                        try {
                            Uri tgUri = Uri.parse(newUrl);
                            String domain = tgUri.getQueryParameter("domain");
                            String start = tgUri.getQueryParameter("start");
                            String httpsFallback = null;
                            if (domain != null) {
                                httpsFallback = "https://t.me/" + domain + (start != null ? "?start=" + Uri.encode(start) : "");
                            }
                            Intent test = new Intent(Intent.ACTION_VIEW, Uri.parse(newUrl));
                            if (test.resolveActivity(getPackageManager()) != null) {
                                openExternal(newUrl);
                            } else if (httpsFallback != null) {
                                openExternal(httpsFallback);
                            } else {
                                view.loadUrl(newUrl);
                            }
                        } catch (Exception e) { openExternal(newUrl); }
                    } else {
                        openExternal(newUrl);
                    }
                    return true;
                }
                if (host.equals(Config.APP_HOST)) {
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
                try {
                    if (url == null || url.startsWith("blob:")) return;
                    String name = url.substring(url.lastIndexOf('/') + 1);
                    if (name.isEmpty() || name.contains("?")) name = "download.xlsx";
                    DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                    req.setTitle(name);
                    if (mimetype != null) req.setMimeType(mimetype);
                    req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                    DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                    if (dm != null) dm.enqueue(req);
                } catch (Exception e) {
                    Log.e(TAG, "download: " + e.getMessage());
                }
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
            public void download(String name, String dataUrl) {
                saveDownload(name, dataUrl);
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
            public String getBubbleConfig() {
                SharedPreferences p = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                JSONObject o = new JSONObject();
                try {
                    o.put("icon", p.getString("bubble_icon", "claudeCodePlayful"));
                    o.put("color", p.getString("bubble_color", "#ef4444"));
                    o.put("size", p.getInt("bubble_size", 60));
                    if (p.contains("bubble_x")) o.put("x", p.getInt("bubble_x", 0)); else o.put("x", JSONObject.NULL);
                    if (p.contains("bubble_y")) o.put("y", p.getInt("bubble_y", 0)); else o.put("y", JSONObject.NULL);
                } catch (Exception ignored) {}
                return o.toString();
            }

            @JavascriptInterface
            public void setBubbleConfig(String json) {
                try {
                    JSONObject o = new JSONObject(json == null ? "{}" : json);
                    SharedPreferences.Editor ed = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit();
                    if (o.has("icon")) ed.putString("bubble_icon", o.optString("icon", "claudeCodePlayful"));
                    if (o.has("color")) ed.putString("bubble_color", o.optString("color", "#ef4444"));
                    if (o.has("size")) ed.putInt("bubble_size", o.optInt("size", 60));
                    if (o.has("x") && !o.isNull("x")) ed.putInt("bubble_x", o.optInt("x", 0));
                    if (o.has("y") && !o.isNull("y")) ed.putInt("bubble_y", o.optInt("y", 0));
                    ed.apply();
                    FloatingBubbleService.applyConfig(MainActivity.this);
                } catch (Exception e) { Log.e(TAG, "setBubbleConfig: " + e.getMessage()); }
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
                        Toast.makeText(MainActivity.this, "Checking for updates", Toast.LENGTH_SHORT).show();
                    }
                });
                fetchLatestRelease(new ReleaseListener() {
                    @Override
                    public void onResult(final JSONObject json) {
                        final String tag = json.optString("tag_name");
                        if (!tag.matches("v\\d+")) return;
                        final String ver = tag.substring(1);
                        try {
                            int installed = getPackageManager().getPackageInfo(getPackageName(), 0).versionCode;
                            if (Integer.parseInt(ver) <= installed) {
                                runOnUiThread(new Runnable() {
                                    @Override
                                    public void run() {
                                        Toast.makeText(MainActivity.this, "You're up to date (v" + ver + ")", Toast.LENGTH_SHORT).show();
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
                                    showUpdateCard(ver, mb, body, apkUrl, asset.optLong("size"));
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
            public void openSupport() {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("https://t.me/Cryptoistaken")));
                        } catch (Exception e) {
                            Log.e(TAG, "openSupport: " + e.getMessage());
                        }
                    }
                });
            }

            @JavascriptInterface
            public void whatsNew() {
                fetchLatestRelease(new ReleaseListener() {
                    @Override
                    public void onResult(final JSONObject json) {
                        final String tag = json.optString("tag_name");
                        final String ver = tag.startsWith("v") ? tag.substring(1) : tag;
                        final String body = json.optString("body", "").trim();
                        runOnUiThread(new Runnable() {
                            @Override
                            public void run() {
                                if (tag.isEmpty()) {
                                    Toast.makeText(MainActivity.this, R.string.whats_new_error, Toast.LENGTH_LONG).show();
                                    return;
                                }
                                if (isFinishing() || isDestroyed()) return;
                                final Dialog d = makeCardDialog();
                                LinearLayout layout = makeCardLayout();
                                layout.addView(makeCardTitle(getString(R.string.whats_new_title) + " in v" + ver));
                                if (body.isEmpty()) {
                                    layout.addView(makeCardBody(getString(R.string.whats_new_empty)));
                                } else {
                                    TextView notes = makeCardBody(body);
                                    notes.setTextSize(12);
                                    notes.setLineSpacing(dp(3), 1f);
                                    layout.addView(notes);
                                }
                                Button ok = makePrimaryButton("OK");
                                ok.setOnClickListener(new View.OnClickListener() {
                                    @Override
                                    public void onClick(View v) {
                                        try {
                                            d.dismiss();
                                        } catch (Exception ignored) {}
                                    }
                                });
                                addButtonRow(layout, ok);
                                d.setContentView(layout);
                                d.show();
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

    webView.loadUrl(Config.HOME_URL);
        pollHandler.post(pollRunnable);

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(this)) {
            if (getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getString("bubble_file", null) != null) {
                FloatingBubbleService.start(this);
            }
        }
    }

    private interface ReleaseListener {
        void onResult(JSONObject release);
        void onError();
    }

    private void fetchLatestRelease(final ReleaseListener listener) {
        final String releasesUrl = "https://api.github.com/repos/" + Config.GITHUB_REPO + "/releases/latest";
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
        final String pollUrl = Config.HOME_URL + "/api/auth/device?token=" + did;
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
            cm.setCookie(Config.HOME_URL, cookie, new ValueCallback<Boolean>() {
                @Override
                public void onReceiveValue(Boolean value) {
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            if (webView != null) webView.loadUrl(Config.HOME_URL);
                        }
                    });
                }
            });
        } else {
            cm.setCookie(Config.HOME_URL, cookie);
            if (webView != null) webView.loadUrl(Config.HOME_URL);
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

    private void saveDownload(final String rawName, final String dataUrl) {
        try {
            if (dataUrl == null || dataUrl.indexOf(',') < 0) return;
            String meta = dataUrl.substring(0, dataUrl.indexOf(','));
            String b64 = dataUrl.substring(dataUrl.indexOf(',') + 1);
            byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
            final String name = sanitizeFileName(rawName);
            String mime = meta.contains("csv") ? "text/csv"
                    : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues cv = new ContentValues();
                cv.put(MediaStore.Downloads.DISPLAY_NAME, name);
                cv.put(MediaStore.Downloads.MIME_TYPE, mime);
                cv.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/SheetSubmit");
                Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                if (uri == null) throw new IOException("No Downloads provider");
                OutputStream os = getContentResolver().openOutputStream(uri);
                if (os == null) throw new IOException("Cannot open Downloads");
                os.write(bytes);
                os.close();
            } else {
                File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "SheetSubmit");
                if (!dir.exists()) dir.mkdirs();
                FileOutputStream fos = new FileOutputStream(new File(dir, name));
                fos.write(bytes);
                fos.close();
            }
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Toast.makeText(MainActivity.this, "Saved to Downloads/SheetSubmit/" + name, Toast.LENGTH_LONG).show();
                }
            });
        } catch (Exception e) {
            Log.e(TAG, "saveDownload: " + e.getMessage());
            final String err = e.getMessage();
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Toast.makeText(MainActivity.this, "Download failed: " + (err == null ? "unknown" : err), Toast.LENGTH_LONG).show();
                }
            });
        }
    }

    private String sanitizeFileName(String raw) {
        String s = raw == null ? "download.xlsx" : raw;
        s = s.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
        return s.isEmpty() ? "download.xlsx" : s;
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

    private int dp(float v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private Dialog makeCardDialog() {
        Dialog d = new Dialog(this);
        d.requestWindowFeature(Window.FEATURE_NO_TITLE);
        Window w = d.getWindow();
        if (w != null) {
            w.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            WindowManager.LayoutParams lp = w.getAttributes();
            lp.dimAmount = 0.35f;
            w.setAttributes(lp);
            w.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
            int width = Math.min(dp(300), getResources().getDisplayMetrics().widthPixels - dp(48));
            w.setLayout(width, WindowManager.LayoutParams.WRAP_CONTENT);
        }
        return d;
    }

    private LinearLayout makeCardLayout() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(getColor(R.color.ss_dialog_bg));
        bg.setStroke(dp(1), getColor(R.color.ss_dialog_border));
        bg.setCornerRadius(dp(8));
        layout.setBackground(bg);
        int p = dp(16);
        layout.setPadding(p, p, p, p);
        return layout;
    }

    private TextView makeCardTitle(String text) {
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextSize(15);
        tv.setTypeface(tv.getTypeface(), Typeface.BOLD);
        tv.setTextColor(getColor(R.color.ss_title_text));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = dp(8);
        tv.setLayoutParams(lp);
        return tv;
    }

    private TextView makeCardBody(String text) {
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextSize(13);
        tv.setTextColor(getColor(R.color.ss_body_text));
        return tv;
    }

    private TextView makeCardHeading(String text) {
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextSize(12);
        tv.setTypeface(tv.getTypeface(), Typeface.BOLD);
        tv.setTextColor(getColor(R.color.ss_title_text));
        return tv;
    }

    private View makeCardDivider() {
        View v = new View(this);
        v.setBackgroundColor(getColor(R.color.ss_dialog_border));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(1));
        lp.topMargin = dp(12);
        lp.bottomMargin = dp(12);
        v.setLayoutParams(lp);
        return v;
    }

    private Button makePrimaryButton(String text) {
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        b.setTextSize(13);
        b.setTypeface(b.getTypeface(), Typeface.BOLD);
        b.setTextColor(getColor(R.color.ss_btn_primary_text));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(getColor(R.color.ss_btn_primary_bg));
        bg.setCornerRadius(dp(6));
        b.setBackground(bg);
        b.setPadding(dp(24), dp(12), dp(24), dp(12));
        b.setMinWidth(0);
        b.setMinHeight(0);
        return b;
    }

    private Button makeGhostButton(String text) {
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        b.setTextSize(13);
        b.setTextColor(getColor(R.color.ss_btn_ghost_text));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.TRANSPARENT);
        bg.setStroke(dp(1), getColor(R.color.ss_btn_ghost_border));
        bg.setCornerRadius(dp(6));
        b.setBackground(bg);
        b.setPadding(dp(24), dp(12), dp(24), dp(12));
        b.setMinWidth(0);
        b.setMinHeight(0);
        return b;
    }

    private void addButtonRow(LinearLayout layout, Button... buttons) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
        for (int i = 0; i < buttons.length; i++) {
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            if (i > 0) lp.leftMargin = dp(8);
            row.addView(buttons[i], lp);
        }
        LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        rlp.topMargin = dp(16);
        layout.addView(row, rlp);
    }

    private LinearLayout makeProgressCard(int totalBytes) {
        LinearLayout layout = makeCardLayout();
        layout.addView(makeCardTitle("Downloading update"));
        ProgressBar bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(100);
        bar.setProgressDrawable(getDrawable(R.drawable.bg_progress_bar));
        TextView text = makeCardBody(String.format(Locale.US, "0%% %.1f / %.1f MB", totalBytes / 1048576.0, totalBytes / 1048576.0));
        progressBar = bar;
        progressText = text;
        LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        blp.topMargin = dp(12);
        layout.addView(bar, blp);
        LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        tlp.topMargin = dp(8);
        layout.addView(text, tlp);
        return layout;
    }

    private void showUpdateCard(final String ver, final long mb, final String body,
                                final String apkUrl, final long sizeBytes) {
        if (isFinishing() || isDestroyed()) return;
        if (updateDialog != null && updateDialog.isShowing()) {
            try {
                updateDialog.dismiss();
            } catch (Exception ignored) {}
        }
        LinearLayout layout = makeCardLayout();
        layout.addView(makeCardTitle("Update available"));
        layout.addView(makeCardBody("v" + ver + ", " + mb + " MB. Install over the current version, data preserved"));
        if (!body.isEmpty()) {
            layout.addView(makeCardDivider());
            layout.addView(makeCardHeading("What's new"));
            TextView notes = makeCardBody(body);
            notes.setTextSize(12);
            notes.setLineSpacing(dp(3), 1f);
            layout.addView(notes);
        }
        Button ghost = makeGhostButton("Later");
        ghost.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (updateDialog != null) {
                    try {
                        updateDialog.dismiss();
                    } catch (Exception ignored) {}
                }
            }
        });
        Button primary = makePrimaryButton("Update");
        primary.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (updateDialog != null) {
                    try {
                        updateDialog.dismiss();
                    } catch (Exception ignored) {}
                }
                launchDownload(apkUrl, sizeBytes);
            }
        });
        addButtonRow(layout, ghost, primary);
        Dialog d = makeCardDialog();
        d.setContentView(layout);
        updateDialog = d;
        updateDialog.show();
    }

    private void launchDownload(final String apkUrl, final long sizeBytes) {
        if (isFinishing() || isDestroyed()) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getPackageManager().canRequestPackageInstalls()) {
            pendingApkUrl = apkUrl;
            pendingApkSize = sizeBytes;
            // ACTION_MANAGE_UNKNOWN_APP_SOURCES + package: Uri opens the per-app
            // "Install unknown apps" screen on API 26+ and the generic one below.
            final Intent settingsIntent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getPackageName()));
            // Deferring show() keeps this out of the update dialog's button-click
            // dispatch, avoiding WindowManager$BadTokenException on dismissal races.
            pollHandler.post(new Runnable() {
                @Override
                public void run() {
                    if (isFinishing() || isDestroyed()) return;
                    final Dialog dialog = makeCardDialog();
                    LinearLayout layout = makeCardLayout();
                    layout.addView(makeCardTitle("Allow installing updates?"));
                    layout.addView(makeCardBody("SheetSubmit needs to install the update. You'll be taken to Settings to allow \"Install unknown apps\" for SheetSubmit. This is required only once."));
                    Button cancel = makeGhostButton("Cancel");
                    cancel.setOnClickListener(new View.OnClickListener() {
                        @Override
                        public void onClick(View v) {
                            try {
                                dialog.dismiss();
                            } catch (Exception ignored) {}
                        }
                    });
                    Button allow = makePrimaryButton("Allow");
                    allow.setOnClickListener(new View.OnClickListener() {
                        @Override
                        public void onClick(View v) {
                            try {
                                startActivityForResult(settingsIntent, REQ_UNKNOWN_APP_SOURCES);
                            } catch (Exception e) {
                                pendingApkUrl = null;
                                pendingApkSize = 0;
                                Toast.makeText(MainActivity.this,
                                        "Couldn't open install-permission settings. Please enable \"Install unknown apps\" for SheetSubmit in your system settings, then try again.",
                                        Toast.LENGTH_LONG).show();
                            }
                            try {
                                dialog.dismiss();
                            } catch (Exception ignored) {}
                        }
                    });
                    addButtonRow(layout, cancel, allow);
                    dialog.setContentView(layout);
                    permissionDialog = dialog;
                    permissionDialog.show();
                }
            });
        } else {
            startDownload(apkUrl, sizeBytes);
        }
    }

    private void startDownload(final String apkUrl, final long totalBytes) {
        if (isFinishing() || isDestroyed()) return;
        showProgressDialog(totalBytes);
        new Thread(new Runnable() {
            @Override
            public void run() {
                Exception last = null;
                for (int attempt = 0; attempt < UPDATE_RETRIES; attempt++) {
                    HttpURLConnection conn = null;
                    InputStream is = null;
                    FileOutputStream fos = null;
                    try {
                        File dir = new File(getCacheDir(), "apk");
                        if (!dir.exists()) dir.mkdirs();
                        final File target = new File(dir, "update.apk");
                        if (target.exists()) target.delete();
                        URL u = new URL(apkUrl);
                        conn = (HttpURLConnection) u.openConnection();
                        conn.setConnectTimeout(DOWNLOAD_CONNECT_TIMEOUT);
                        conn.setReadTimeout(DOWNLOAD_READ_TIMEOUT);
                        conn.setRequestProperty("User-Agent", "SheetSubmit-Updater");
                        conn.setRequestMethod("GET");
                        int code = conn.getResponseCode();
                        if (code != 200) throw new IOException("Download failed (HTTP " + code + ")");
                        is = conn.getInputStream();
                        fos = new FileOutputStream(target);
                        byte[] buf = new byte[8192];
                        long downloaded = 0;
                        int n;
                        int lastPct = -1;
                        while ((n = is.read(buf)) != -1) {
                            fos.write(buf, 0, n);
                            downloaded += n;
                            if (totalBytes > 0) {
                                final int pct = (int) (downloaded * 100 / totalBytes);
                                if (pct != lastPct) {
                                    lastPct = pct;
                                    final long dl = downloaded;
                                    runOnUiThread(new Runnable() {
                                        @Override
                                        public void run() {
                                            if (destroyed) return;
                                            updateProgress(pct, dl, totalBytes);
                                        }
                                    });
                                }
                            }
                        }
                        fos.flush();
                        fos.close();
                        fos = null;
                        is.close();
                        is = null;
                        conn.disconnect();
                        conn = null;
                        final File apk = target;
                        runOnUiThread(new Runnable() {
                            @Override
                            public void run() {
                                if (destroyed || isFinishing() || isDestroyed()) return;
                                dismissProgress();
                                openInstaller(apk);
                            }
                        });
                        return;
                    } catch (Exception e) {
                        last = e;
                        if (destroyed) return;
                        if (fos != null) {
                            try { fos.close(); } catch (Exception ignored) {}
                        }
                        if (is != null) {
                            try { is.close(); } catch (Exception ignored) {}
                        }
                        if (conn != null) conn.disconnect();
                        if (attempt < UPDATE_RETRIES - 1) {
                            try {
                                Thread.sleep(1000L * (attempt + 1));
                            } catch (InterruptedException ie) {
                                Thread.currentThread().interrupt();
                            }
                        }
                    }
                }
                final String err = last != null && last.getMessage() != null ? last.getMessage() : "Update failed";
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (destroyed || isFinishing() || isDestroyed()) return;
                        dismissProgress();
                        Toast.makeText(MainActivity.this, err, Toast.LENGTH_LONG).show();
                    }
                });
            }
        }).start();
    }

    private void showProgressDialog(long totalBytes) {
        if (isFinishing() || isDestroyed()) return;
        LinearLayout layout = makeProgressCard((int) totalBytes);
        Dialog d = makeCardDialog();
        d.setCancelable(false);
        d.setContentView(layout);
        progressDialog = d;
        progressDialog.show();
    }

    private void updateProgress(int pct, long downloaded, long totalBytes) {
        if (progressBar != null) progressBar.setProgress(pct);
        if (progressText != null) {
            progressText.setText(String.format(Locale.US, "%d%% %.1f / %.1f MB",
                    pct, downloaded / 1048576.0, totalBytes / 1048576.0));
        }
    }

    private void dismissProgress() {
        if (progressDialog != null && progressDialog.isShowing()) {
            try {
                progressDialog.dismiss();
            } catch (Exception ignored) {}
        }
        progressDialog = null;
        progressBar = null;
        progressText = null;
    }

    private void dismissPermissionDialog() {
        if (permissionDialog != null && permissionDialog.isShowing()) {
            try {
                permissionDialog.dismiss();
            } catch (Exception ignored) {}
        }
        permissionDialog = null;
    }

    private void openInstaller(File apk) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(ApkProvider.uriFor(this, apk), "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivity(intent);
        } catch (Exception e) {
            Toast.makeText(MainActivity.this, "Cannot open installer", Toast.LENGTH_LONG).show();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_OVERLAY_PERMISSION) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(this)) {
                FloatingBubbleService.start(this);
            }
        }
        if (requestCode == REQ_UNKNOWN_APP_SOURCES) {
            dismissPermissionDialog();
            if (getPackageManager().canRequestPackageInstalls()) {
                if (pendingApkUrl != null) {
                    startDownload(pendingApkUrl, pendingApkSize);
                    pendingApkUrl = null;
                }
            } else {
                pendingApkUrl = null;
                pendingApkSize = 0;
                Toast.makeText(this,
                        "Please allow 'Install unknown apps' for SheetSubmit, then try again",
                        Toast.LENGTH_LONG).show();
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
        destroyed = true;
        pollHandler.removeCallbacks(pollRunnable);
        dismissProgress();
        dismissPermissionDialog();
        if (webView != null) {
            try {
                if (webView.getParent() != null) {
                    ((ViewGroup) webView.getParent()).removeView(webView);
                }
            } catch (Exception ignored) {}
            webView.destroy();
        }
        super.onDestroy();
    }
}
