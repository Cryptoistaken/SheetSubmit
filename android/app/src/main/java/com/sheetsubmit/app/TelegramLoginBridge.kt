package com.sheetsubmit.app

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.CookieManager
import android.webkit.WebView
import org.json.JSONObject
import org.telegram.login.TelegramLogin

object TelegramLoginBridge {
    private const val TAG = "TelegramLogin"
    const val CLIENT_ID = "8667114953"
    const val REDIRECT_URI = "https://app3974912127-login.tg.dev/tglogin"
    const val HOST = "app3974912127-login.tg.dev"

    @JvmStatic
    fun init() {
        try {
            TelegramLogin.init(CLIENT_ID, REDIRECT_URI, listOf("profile"))
        } catch (e: Exception) {
            Log.e(TAG, "init failed: " + e.message)
        }
    }

    @JvmStatic
    fun startLogin(ctx: Context) {
        try {
            TelegramLogin.startLogin(ctx)
        } catch (e: Exception) {
            Log.e(TAG, "startLogin failed: " + e.message)
        }
    }

    @JvmStatic
    fun isTelegramRedirect(uri: Uri?): Boolean {
        if (uri == null) return false
        if (uri.host != HOST) return false
        val p = uri.path ?: return false
        return p == "/tglogin" || p.startsWith("/tglogin/")
    }

    fun handleResponse(uri: Uri, onToken: (String) -> Unit, onError: (String) -> Unit) {
        try {
            TelegramLogin.handleLoginResponse(uri, { data ->
                onToken(data.idToken)
            }, { err ->
                onError(err.message)
            })
        } catch (e: Exception) {
            onError(e.message ?: "handleLoginResponse failed")
        }
    }

    @JvmStatic
    fun handleResponseJava(uri: Uri, onToken: java.util.function.Consumer<String>, onError: java.util.function.Consumer<String>) {
        handleResponse(uri, { t -> onToken.accept(t) }, { e -> onError.accept(e) })
    }

    @JvmStatic
    fun verifyAndApply(ctx: Context, idToken: String, homeUrl: String, webView: WebView?) {
        Thread {
            var conn: java.net.HttpURLConnection? = null
            try {
                val url = java.net.URL(homeUrl + "/api/auth/telegram/verify")
                conn = url.openConnection() as java.net.HttpURLConnection
                conn.requestMethod = "POST"
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.setRequestProperty("Accept", "application/json")
                conn.connectTimeout = 10000
                conn.readTimeout = 10000
                val body = JSONObject().put("id_token", idToken).toString()
                conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                val code = conn.responseCode
                if (code != 200) {
                    Log.e(TAG, "verify failed HTTP $code")
                    return@Thread
                }
                var ssCookie: String? = null
                for ((k, v) in conn.headerFields) {
                    if (k != null && k.equals("Set-Cookie", ignoreCase = true)) {
                        for (h in v) if (h.contains("ss_session=")) { ssCookie = h; break }
                        if (ssCookie != null) break
                    }
                }
                if (ssCookie == null) {
                    Log.e(TAG, "verify ok but no Set-Cookie")
                    return@Thread
                }
                Handler(Looper.getMainLooper()).post {
                    try {
                        val cm = CookieManager.getInstance()
                        cm.setAcceptCookie(true)
                        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.LOLLIPOP) {
                            cm.setCookie(homeUrl, ssCookie) { _ ->
                                cm.flush()
                                try { webView?.loadUrl(homeUrl) } catch (_: Exception) {}
                            }
                        } else {
                            @Suppress("DEPRECATION")
                            cm.setCookie(homeUrl, ssCookie)
                            try { webView?.loadUrl(homeUrl) } catch (_: Exception) {}
                        }
                    } catch (e: Exception) {
                        Log.e(TAG, "setCookie failed: " + e.message)
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "verifyAndApply error: " + e.message)
            } finally {
                try { conn?.disconnect() } catch (_: Exception) {}
            }
        }.start()
    }
}
