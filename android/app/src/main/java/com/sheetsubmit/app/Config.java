package com.sheetsubmit.app;

public final class Config {

    private Config() {
    }

    // Single source of truth for the app URL. Change BASE_URL only.
    public static final String BASE_URL = "https://seal.up.railway.app";
    public static final String HOME_URL = BASE_URL;
    public static final String APP_HOST = BASE_URL.replaceFirst("^https?://", "");

    // TEST project — isolated from prod (Shadcnui). Updates must come from testmycode repo only.
    public static final String GITHUB_REPO = "Cryptoistaken/SheetSubmit-testmycode";
}