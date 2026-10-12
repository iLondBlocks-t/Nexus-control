package com.nexus.phoneagent.core;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * Local credential storage.
 *
 * The device token is kept in the app's private SharedPreferences, which no
 * other app can read on a non-rooted device. It is wiped by "Revoke local
 * credentials" and by unpairing.
 *
 * Limitation, stated honestly: this is filesystem storage protected by Android's
 * app sandbox, not hardware-backed storage. See docs/SECURITY_MODEL.md.
 */
public final class SecureStore {

    private static final String PREFS = "nexus.credentials";
    private static final String KEY_DEVICE_TOKEN = "device_token";
    private static final String KEY_TOKEN_ISSUED_AT = "device_token_issued_at";

    private final SharedPreferences prefs;

    public SecureStore(Context context) {
        this.prefs = context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public boolean hasCredentials() {
        return getDeviceToken().length() > 0;
    }

    public String getDeviceToken() {
        return prefs.getString(KEY_DEVICE_TOKEN, "");
    }

    public long getTokenIssuedAt() {
        return prefs.getLong(KEY_TOKEN_ISSUED_AT, 0L);
    }

    public void storeDeviceToken(String token) {
        prefs.edit()
                .putString(KEY_DEVICE_TOKEN, token == null ? "" : token)
                .putLong(KEY_TOKEN_ISSUED_AT, System.currentTimeMillis())
                .apply();
    }

    /** Remove the credential immediately. Call when the owner revokes the device. */
    public void clear() {
        prefs.edit().remove(KEY_DEVICE_TOKEN).remove(KEY_TOKEN_ISSUED_AT).apply();
    }
}
