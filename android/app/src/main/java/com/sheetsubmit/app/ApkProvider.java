package com.sheetsubmit.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * Minimal content provider (this project has no AndroidX support lib) that
 * exposes cached APKs to the system package installer. Files live in
 * cacheDir/apk/ and are served read-only.
 *
 * Export decision: android:exported="false" in the manifest is correct.
 * The system package installer reads the APK through the temporary URI
 * grant from FLAG_GRANT_READ_URI_PERMISSION, which works for non-exported
 * providers exactly like androidx FileProvider (also exported="false").
 * Granting works because android:grantUriPermissions="true" is set. Keeping
 * the provider non-exported means only packages we explicitly hand a URI
 * grant to can read files — exported="true" would let any app that guesses
 * a file name read the downloaded APK. Do not flip it to true.
 */
public class ApkProvider extends ContentProvider {

    public static final String AUTHORITY = "org.brilliant.android.apk";
    private static final String DIR = "apk";

    public static Uri uriFor(Context ctx, File file) {
        return Uri.parse("content://" + AUTHORITY + "/" + file.getName());
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        String name = uri.getLastPathSegment();
        if (name == null || name.isEmpty()
                || name.equals(".") || name.equals("..")
                || name.indexOf('/') >= 0
                || name.indexOf(File.separatorChar) >= 0) {
            throw new FileNotFoundException("invalid file name");
        }
        Context ctx = getContext();
        if (ctx == null) throw new FileNotFoundException("no context");
        File f = new File(new File(ctx.getCacheDir(), DIR), name);
        // Installer asks for "r"; always serve read-only regardless of the
        // requested mode. Missing file -> FileNotFoundException delivered to
        // the installer (shows an error); our process does not crash.
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public String getType(Uri uri) {
        return "application/vnd.android.package-archive";
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        return null;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }
}