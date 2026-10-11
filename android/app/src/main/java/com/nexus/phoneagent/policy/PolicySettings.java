package com.nexus.phoneagent.policy;

/**
 * A snapshot of the owner's per-capability switches.
 *
 * Deliberately free of Android types so the validation rules below can be unit
 * tested on a plain JVM: `LocalPolicy` never reads SharedPreferences itself, it
 * is handed one of these.
 */
public final class PolicySettings {

    public final boolean allowTap;
    public final boolean allowScroll;
    public final boolean allowTypeText;
    public final boolean allowReadScreen;

    public PolicySettings(boolean allowTap, boolean allowScroll, boolean allowTypeText, boolean allowReadScreen) {
        this.allowTap = allowTap;
        this.allowScroll = allowScroll;
        this.allowTypeText = allowTypeText;
        this.allowReadScreen = allowReadScreen;
    }

    /** Every capability on: what a freshly paired phone looks like. */
    public static PolicySettings allowAll() {
        return new PolicySettings(true, true, true, true);
    }

    /** No capability on: what the phone does when the owner turns everything off. */
    public static PolicySettings denyAll() {
        return new PolicySettings(false, false, false, false);
    }

    /**
     * Navigation the owner asked for explicitly is always available; the four
     * interactive capabilities are the ones the owner can switch off.
     */
    public boolean isAllowed(String actionType) {
        switch (actionType) {
            case "tap_element":
                return allowTap;
            case "scroll":
                return allowScroll;
            case "type_text":
                return allowTypeText;
            case "read_visible_ui":
                return allowReadScreen;
            case "open_app":
            case "open_settings":
            case "wait_for_screen":
            case "back":
            case "stop":
                return true;
            default:
                return false;
        }
    }
}
