package com.nexus.phoneagent.ui;

import android.content.Context;

import com.nexus.phoneagent.R;
import com.nexus.phoneagent.model.ConnectionState;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/** Small formatting helpers shared by the screens. */
public final class Format {

    private Format() {
    }

    public static String stateLabel(Context context, ConnectionState state) {
        if (state == null) {
            return context.getString(R.string.state_disconnected);
        }
        switch (state) {
            case NOT_CONFIGURED:
                return context.getString(R.string.state_not_configured);
            case WAITING_FOR_PAIRING:
                return context.getString(R.string.state_waiting_pairing);
            case CONNECTING:
                return context.getString(R.string.state_connecting);
            case CONNECTED:
                return context.getString(R.string.state_connected);
            case RECONNECTING:
                return context.getString(R.string.state_reconnecting);
            case AUTH_FAILED:
                return context.getString(R.string.state_auth_failed);
            case ACCESSIBILITY_REQUIRED:
                return context.getString(R.string.state_accessibility_required);
            case SERVER_UNAVAILABLE:
                return context.getString(R.string.state_server_unavailable);
            case REVOKED:
                return context.getString(R.string.state_revoked);
            case DISCONNECTED:
            default:
                return context.getString(R.string.state_disconnected);
        }
    }

    public static int stateColor(Context context, ConnectionState state) {
        if (state == null) {
            return context.getResources().getColor(R.color.status_idle);
        }
        switch (state) {
            case CONNECTED:
                return context.getResources().getColor(R.color.status_ok);
            case CONNECTING:
            case RECONNECTING:
                return context.getResources().getColor(R.color.status_warn);
            case AUTH_FAILED:
            case REVOKED:
            case SERVER_UNAVAILABLE:
            case DISCONNECTED:
                return context.getResources().getColor(R.color.status_error);
            default:
                return context.getResources().getColor(R.color.status_idle);
        }
    }

    /** "12:41:07" or an em dash when the timestamp is unknown. */
    public static String time(long millis) {
        if (millis <= 0L) {
            return "—";
        }
        return new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(new Date(millis));
    }

    /** "3.4 s", "1 m 12 s". */
    public static String duration(long millis) {
        if (millis <= 0L) {
            return "—";
        }
        if (millis < 1000L) {
            return millis + " ms";
        }
        long seconds = millis / 1000L;
        if (seconds < 60L) {
            return seconds + "." + ((millis % 1000L) / 100L) + " s";
        }
        long minutes = seconds / 60L;
        return minutes + " m " + (seconds % 60L) + " s";
    }

    public static String status(String raw) {
        if (raw == null || raw.isEmpty()) {
            return "unknown";
        }
        return raw.replace('_', ' ');
    }
}
