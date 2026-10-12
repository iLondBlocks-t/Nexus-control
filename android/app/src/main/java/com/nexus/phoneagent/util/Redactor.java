package com.nexus.phoneagent.util;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Removes anything sensitive from text before it can leave the phone.
 *
 * The device only ever sends a minimal, redacted summary of the visible screen,
 * so credentials, one-time codes and card numbers never reach the server.
 */
public final class Redactor {

    /** Marker inserted wherever something sensitive was removed. */
    public static final String PLACEHOLDER = "[hidden]";

    private static final Pattern DIGIT_RUNS = Pattern.compile("\\d{4,}");
    private static final Pattern EMAIL = Pattern.compile("[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}");
    private static final Pattern LONG_SECRET = Pattern.compile("(?:\\d|\\W)*[A-Za-z]+\\d+[A-Za-z0-9!@#$%^&*]{6,}(?:\\d|\\W)*");
    private static final Pattern SECRET_WORDS = Pattern.compile(
            "(?i)(password|passwd|passcode|pin|cvv|cvc|otp|one[-\\s]?time|verification[-\\s]?code|"
                    + "card[-\\s]?number|iban|account[-\\s]?number|secret|token|api[-\\s]?key)");

    private Redactor() {
    }

    /** Redact a single piece of visible text. */
    public static String redact(String input) {
        if (input == null) {
            return "";
        }
        String value = input.trim();
        if (value.isEmpty()) {
            return "";
        }
        if (SECRET_WORDS.matcher(value).find()) {
            return PLACEHOLDER;
        }
        if (EMAIL.matcher(value).find()) {
            value = EMAIL.matcher(value).replaceAll(PLACEHOLDER);
        }
        Matcher digits = DIGIT_RUNS.matcher(value);
        if (digits.find()) {
            value = digits.replaceAll(PLACEHOLDER);
        }
        return truncate(value, 200);
    }

    /** True when the text looks like a credential and must never be typed or stored. */
    public static boolean looksSensitive(String input) {
        if (input == null || input.trim().isEmpty()) {
            return false;
        }
        String value = input.trim();
        if (SECRET_WORDS.matcher(value).find()) {
            return true;
        }
        // A bare 4+ digit run is treated as a possible PIN or one-time code.
        if (DIGIT_RUNS.matcher(value).find()) {
            return true;
        }
        return LONG_SECRET.matcher(value).matches();
    }

    /** True when a field label marks it as a secret field (password, PIN, card…). */
    public static boolean isSensitiveFieldLabel(String label) {
        return label != null && SECRET_WORDS.matcher(label).find();
    }

    public static String truncate(String value, int maxLength) {
        if (value == null) {
            return "";
        }
        return value.length() <= maxLength ? value : value.substring(0, maxLength) + "…";
    }
}
