package com.nexus.phoneagent.core;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.HashSet;
import java.util.Set;

/**
 * Owner configurable settings.
 *
 * Everything the owner can change lives in SharedPreferences so no credential or
 * endpoint is ever compiled into the APK.
 */
public final class Config {

    private static final String PREFS = "nexus.settings";
    private static final String KEY_SERVER_URL = "server_url";
    private static final String KEY_WS_OVERRIDE = "ws_override";
    private static final String KEY_DEVICE_ID = "device_id";
    private static final String KEY_DEVICE_LABEL = "device_label";
    private static final String KEY_PAIRED = "paired";
    private static final String KEY_MAX_ACTIONS = "max_actions";
    private static final String KEY_MAX_DURATION = "max_duration_seconds";
    private static final String KEY_ALLOW_TAP = "allow_tap";
    private static final String KEY_ALLOW_SCROLL = "allow_scroll";
    private static final String KEY_ALLOW_TYPE = "allow_type";
    private static final String KEY_ALLOW_READ = "allow_read";
    private static final String KEY_SHARE_PACKAGES = "share_packages";
    private static final String KEY_RETENTION_DAYS = "retention_days";
    private static final String KEY_AUTO_RECONNECT = "auto_reconnect";

    /** Device endpoint exposed by the NEXUS server. */
    public static final String WEBSOCKET_PATH = "/api/v1/device";

    public static final int DEFAULT_MAX_ACTIONS = 12;
    public static final int DEFAULT_MAX_DURATION_SECONDS = 90;
    public static final int DEFAULT_RETENTION_DAYS = 30;

    private final SharedPreferences prefs;

    public Config(Context context) {
        this.prefs = context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public String getServerUrl() {
        return prefs.getString(KEY_SERVER_URL, "");
    }

    public void setServerUrl(String value) {
        prefs.edit().putString(KEY_SERVER_URL, value == null ? "" : value.trim()).apply();
    }

    public String getWebSocketOverride() {
        return prefs.getString(KEY_WS_OVERRIDE, "");
    }

    public void setWebSocketOverride(String value) {
        prefs.edit().putString(KEY_WS_OVERRIDE, value == null ? "" : value.trim()).apply();
    }

    public boolean isConfigured() {
        return isHttpUrl(getServerUrl());
    }

    public String getDeviceId() {
        return prefs.getString(KEY_DEVICE_ID, "");
    }

    public void setDeviceId(String deviceId) {
        prefs.edit().putString(KEY_DEVICE_ID, deviceId == null ? "" : deviceId).apply();
    }

    public String getDeviceLabel() {
        return prefs.getString(KEY_DEVICE_LABEL, "");
    }

    public void setDeviceLabel(String label) {
        prefs.edit().putString(KEY_DEVICE_LABEL, label == null ? "" : label).apply();
    }

    public boolean isPaired() {
        return prefs.getBoolean(KEY_PAIRED, false);
    }

    public void setPaired(boolean paired) {
        prefs.edit().putBoolean(KEY_PAIRED, paired).apply();
    }

    public int getMaxActions() {
        return clamp(prefs.getInt(KEY_MAX_ACTIONS, DEFAULT_MAX_ACTIONS), 1, 30);
    }

    public void setMaxActions(int value) {
        prefs.edit().putInt(KEY_MAX_ACTIONS, clamp(value, 1, 30)).apply();
    }

    public int getMaxDurationSeconds() {
        return clamp(prefs.getInt(KEY_MAX_DURATION, DEFAULT_MAX_DURATION_SECONDS), 10, 900);
    }

    public void setMaxDurationSeconds(int value) {
        prefs.edit().putInt(KEY_MAX_DURATION, clamp(value, 10, 900)).apply();
    }

    public boolean isActionAllowed(String actionType) {
        switch (actionType) {
            case "tap_element":
                return prefs.getBoolean(KEY_ALLOW_TAP, true);
            case "scroll":
                return prefs.getBoolean(KEY_ALLOW_SCROLL, true);
            case "type_text":
                return prefs.getBoolean(KEY_ALLOW_TYPE, true);
            case "read_visible_ui":
                return prefs.getBoolean(KEY_ALLOW_READ, true);
            case "open_app":
            case "open_settings":
            case "wait_for_screen":
            case "back":
            case "stop":
                // Always allowed: navigation the owner asked for explicitly.
                return true;
            default:
                return false;
        }
    }

    public void setActionAllowed(String actionType, boolean allowed) {
        String key;
        switch (actionType) {
            case "tap_element":
                key = KEY_ALLOW_TAP;
                break;
            case "scroll":
                key = KEY_ALLOW_SCROLL;
                break;
            case "type_text":
                key = KEY_ALLOW_TYPE;
                break;
            case "read_visible_ui":
                key = KEY_ALLOW_READ;
                break;
            default:
                return;
        }
        prefs.edit().putBoolean(key, allowed).apply();
    }

    public boolean isSharePackagesEnabled() {
        return prefs.getBoolean(KEY_SHARE_PACKAGES, false);
    }

    public void setSharePackagesEnabled(boolean enabled) {
        prefs.edit().putBoolean(KEY_SHARE_PACKAGES, enabled).apply();
    }

    public int getRetentionDays() {
        return clamp(prefs.getInt(KEY_RETENTION_DAYS, DEFAULT_RETENTION_DAYS), 1, 365);
    }

    public void setRetentionDays(int days) {
        prefs.edit().putInt(KEY_RETENTION_DAYS, clamp(days, 1, 365)).apply();
    }

    public boolean isAutoReconnectEnabled() {
        return prefs.getBoolean(KEY_AUTO_RECONNECT, true);
    }

    public void setAutoReconnectEnabled(boolean enabled) {
        prefs.edit().putBoolean(KEY_AUTO_RECONNECT, enabled).apply();
    }

    /** Wipe every local setting and credential (used by "Revoke local credentials"). */
    public void clearAll() {
        prefs.edit().clear().apply();
    }

    /** Package names shared with the planner, only when the owner opted in. */
    public Set<String> getSharedPackages() {
        String stored = prefs.getString("shared_packages", "");
        Set<String> result = new HashSet<>();
        for (String name : stored.split(",")) {
            String trimmed = name.trim();
            if (!trimmed.isEmpty()) {
                result.add(trimmed);
            }
        }
        return result;
    }

    public void setSharedPackages(Set<String> packages) {
        StringBuilder builder = new StringBuilder();
        for (String name : packages) {
            String trimmed = name == null ? "" : name.trim();
            if (trimmed.isEmpty()) {
                continue;
            }
            if (builder.length() > 0) {
                builder.append(',');
            }
            builder.append(trimmed);
        }
        prefs.edit().putString("shared_packages", builder.toString()).apply();
    }

    /** Only https:// endpoints are accepted: the device token must never travel in clear text. */
    public static boolean isHttpUrl(String value) {
        if (value == null) {
            return false;
        }
        String trimmed = value.trim();
        return trimmed.startsWith("https://") && trimmed.length() > 10;
    }

    /** Only wss:// endpoints are accepted, for the same reason. */
    public static boolean isWebSocketUrl(String value) {
        if (value == null) {
            return false;
        }
        String trimmed = value.trim();
        return trimmed.startsWith("wss://") && trimmed.length() > 8;
    }

    /**
     * Derive the WebSocket endpoint from the configured server URL.
     * "https://host" -> "wss://host/api/v1/device"
     */
    public String deriveWebSocketUrl() {
        String override = getWebSocketOverride();
        if (isWebSocketUrl(override)) {
            return override.trim();
        }
        String server = getServerUrl().trim();
        if (!isHttpUrl(server)) {
            return "";
        }
        String base = server;
        while (base.endsWith("/")) {
            base = base.substring(0, base.length() - 1);
        }
        return "wss://" + base.substring("https://".length()) + WEBSOCKET_PATH;
    }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }
}
