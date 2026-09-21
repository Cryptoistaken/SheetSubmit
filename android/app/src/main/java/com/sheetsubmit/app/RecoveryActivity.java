package com.sheetsubmit.app;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Emergency offline backup screen. Reads the site's own IndexedDB snapshots
 * (db "ss", store "kv", keys "s:<fileId>") through a WebView bound to the
 * site origin and writes every file as xlsx into one zip in Downloads.
 *
 * No login, no network. Does not touch any existing app data.
 */
public class RecoveryActivity extends Activity {

    private static final String SITE_ORIGIN = "https://sheetsubmit.pages.dev/";
    private static final String[] COLUMNS = {"cookies", "twofakey", "uid"};

    private Button action;
    private TextView status;
    private final List<String[]> pending = new ArrayList<>();
    private volatile boolean working = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setPadding(48, 48, 48, 48);

        action = new Button(this);
        action.setText("Download backup");
        status = new TextView(this);
        status.setGravity(Gravity.CENTER);
        status.setPadding(0, 24, 0, 0);

        root.addView(action, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));
        root.addView(status, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));
        setContentView(root);

        action.setOnClickListener(v -> startBackup());

        // Hidden reader WebView bound to the site origin so its IndexedDB is visible.
        WebView reader = new WebView(this);
        reader.setVisibility(WebView.GONE);
        root.addView(reader, new LinearLayout.LayoutParams(1, 1));
        WebSettings s = reader.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        reader.addJavascriptInterface(new Bridge(), "Android");
        reader.loadDataWithBaseURL(SITE_ORIGIN, READER_HTML, "text/html", "utf-8", null);
    }

    private void startBackup() {
        if (working) return;
        if (Build.VERSION.SDK_INT < 29
                && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, 7);
            return;
        }
        runReader();
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] p, int[] r) {
        super.onRequestPermissionsResult(code, p, r);
        if (code == 7 && r.length > 0 && r[0] == PackageManager.PERMISSION_GRANTED) runReader();
        else toast("Storage denied.");
    }

    private void runReader() {
        synchronized (pending) {
            pending.clear();
        }
        working = true;
        action.setEnabled(false);
        status.setText("Reading files...");
        // Re-load the reader page; it pushes every snapshot to the bridge.
        // The WebView is child 2 of the root layout.
        LinearLayout root = (LinearLayout) action.getParent();
        WebView reader = (WebView) root.getChildAt(2);
        reader.loadDataWithBaseURL(SITE_ORIGIN, READER_HTML, "text/html", "utf-8", null);
    }

    private class Bridge {
        @JavascriptInterface
        public void onFile(String key, String json) {
            synchronized (pending) {
                pending.add(new String[]{key, json});
            }
        }

        @JavascriptInterface
        public void onDone() {
            finishBackup(null);
        }

        @JavascriptInterface
        public void onError(String message) {
            finishBackup(message == null || message.isEmpty() ? "Read failed." : message);
        }
    }

    private void finishBackup(final String readError) {
        new Thread(() -> {
            String result;
            if (readError != null) {
                result = readError;
            } else {
                List<String[]> files;
                synchronized (pending) {
                    files = new ArrayList<>(pending);
                }
                result = exportFiles(files);
            }
            final String out = result;
            runOnUiThread(() -> {
                working = false;
                action.setEnabled(true);
                status.setText(out);
                toast(out);
            });
        }).start();
    }

    private String exportFiles(List<String[]> files) {
        Map<String, byte[]> entries = new LinkedHashMap<>();
        for (String[] kv : files) {
            try {
                JSONObject snap = new JSONObject(kv[1]);
                JSONObject file = snap.optJSONObject("file");
                String name = file != null ? file.optString("name", "") : "";
                if (name.isEmpty()) name = kv[0].substring(2);
                JSONArray rows = snap.optJSONArray("rows");
                if (rows == null) continue;
                List<String[]> grid = new ArrayList<>();
                for (int i = 0; i < rows.length(); i++) {
                    JSONObject r = rows.optJSONObject(i);
                    if (r == null) continue;
                    String c = r.optString("cookies", "");
                    String t = r.optString("twofakey", "");
                    String u = r.optString("uid", "");
                    if (c.isEmpty() && t.isEmpty() && u.isEmpty()) continue;
                    grid.add(new String[]{c, t, u});
                }
                if (grid.isEmpty()) continue;
                byte[] xlsx = RecoveryExport.rowsToXlsx(COLUMNS, grid);
                entries.put(RecoveryExport.uniqueName(entries, name), xlsx);
            } catch (Exception ignored) {
            }
        }
        if (entries.isEmpty()) return "No files found.";
        try {
            String label = RecoveryExport.saveZipToDownloads(this, entries);
            return "Saved " + label + " (" + entries.size() + " files)";
        } catch (Exception e) {
            return "Save failed.";
        }
    }

    private void toast(String message) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show();
    }

    private static final String READER_HTML =
            "<!doctype html><html><body><script>" +
            "(function(){" +
            "function err(m){try{Android.onError(m)}catch(e){}}" +
            "try{" +
            "if(!window.indexedDB){err('No storage found.');return;}" +
            "var req=indexedDB.open('ss',1);" +
            "req.onerror=function(){err('Cannot open storage.')};" +
            "req.onsuccess=function(){" +
            "var db=req.result;" +
            "if(db.objectStoreNames&&!db.objectStoreNames.contains('kv')){err('No files found.');return;}" +
            "try{" +
            "var tx=db.transaction('kv','readonly');" +
            "var st=tx.objectStore('kv');" +
            "var cur=st.openCursor();" +
            "cur.onsuccess=function(e){" +
            "var c=e.target.result;" +
            "if(c){" +
            "if(typeof c.key==='string'&&c.key.indexOf('s:')===0){" +
            "try{Android.onFile(c.key,JSON.stringify(c.value))}catch(x){}}" +
            "c.continue();" +
            "}else{try{Android.onDone()}catch(x){}}" +
            "};" +
            "cur.onerror=function(){err('Read failed.')};" +
            "}catch(x){err('Read failed.');}" +
            "};" +
            "}catch(x){err('Read failed.');}" +
            "})();" +
            "</script></body></html>";
}
