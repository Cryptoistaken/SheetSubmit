package com.sheetsubmit.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Bundle;

/**
 * Transparent activity that briefly comes to the foreground so the app gets
 * input focus — the only way to read the clipboard on Android 10+ from an
 * overlay/service context. Reads the primary clip into SharedPreferences and
 * finishes instantly (never appears in Recents).
 */
public class ClipboardCaptureActivity extends Activity {

    private static final String TAG = "ClipCapture";
    private static final String PREFS_NAME = "sheetsubmit";
    private static final String KEY_CLIP = "bubble_clip";
    private static final String KEY_CLIP_AT = "bubble_clip_at";

    private boolean done = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (!hasFocus || done) return;
        done = true;
        try {
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            String text = "";
            if (cm != null && cm.hasPrimaryClip() && cm.getPrimaryClip() != null && cm.getPrimaryClip().getItemCount() > 0) {
                CharSequence cs = cm.getPrimaryClip().getItemAt(0).getText();
                if (cs != null) text = cs.toString();
            }
            if (!text.isEmpty()) {
                getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                        .edit()
                        .putString(KEY_CLIP, text)
                        .putLong(KEY_CLIP_AT, System.currentTimeMillis())
                        .apply();
            }
        } catch (Exception e) {
            // transient; automation falls back to a direct read which may fail
            // without focus — acceptable
        } finally {
            finish();
        }
    }
}