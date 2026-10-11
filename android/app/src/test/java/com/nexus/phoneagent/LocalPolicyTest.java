package com.nexus.phoneagent;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import com.nexus.phoneagent.policy.LocalPolicy;
import com.nexus.phoneagent.policy.PolicySettings;

import org.json.JSONObject;
import org.junit.Test;

/**
 * The phone's own allowlist.
 *
 * These rules are what a compromised or buggy server still cannot talk the
 * device out of, so every refusal here has a test.
 */
public class LocalPolicyTest {

    private static JSONObject action(String type) {
        return new JSONObject().put("type", type);
    }

    private static JSONObject match(String text) {
        return new JSONObject().put("text", text);
    }

    @Test
    public void theAllowlistIsTheNineKnownTypes() {
        assertEquals(9, LocalPolicy.ALLOWED_TYPES.size());
        assertTrue(LocalPolicy.ALLOWED_TYPES.contains("open_app"));
        assertTrue(LocalPolicy.ALLOWED_TYPES.contains("tap_element"));
        assertFalse(LocalPolicy.ALLOWED_TYPES.contains("shell_command"));
    }

    @Test
    public void unknownActionTypesAreRefused() {
        LocalPolicy.Decision decision = LocalPolicy.validate(action("shell_command"),
                PolicySettings.allowAll(), 1);
        assertFalse(decision.allowed);
        assertEquals("ACTION_NOT_ALLOWED", decision.errorCode);
    }

    @Test
    public void anEmptyActionIsRefused() {
        LocalPolicy.Decision decision = LocalPolicy.validate(null, PolicySettings.allowAll(), 1);
        assertFalse(decision.allowed);
        assertEquals("INVALID_REQUEST", decision.errorCode);
    }

    @Test
    public void theHardActionBudgetIsEnforcedOnThePhone() {
        JSONObject open = action("open_app").put("package_name", "com.google.android.youtube");
        assertTrue(LocalPolicy.validate(open, PolicySettings.allowAll(), 30).allowed);
        assertFalse(LocalPolicy.validate(open, PolicySettings.allowAll(), 31).allowed);
    }

    @Test
    public void aSwitchedOffCapabilityIsRefusedEvenWhenTheServerAsksForIt() {
        assertFalse(LocalPolicy.validate(action("tap_element").put("match", match("Play")),
                PolicySettings.denyAll(), 1).allowed);
        assertFalse(LocalPolicy.validate(action("scroll").put("direction", "down"),
                PolicySettings.denyAll(), 1).allowed);
        assertFalse(LocalPolicy.validate(action("type_text").put("text", "hello"),
                PolicySettings.denyAll(), 1).allowed);
        assertFalse(LocalPolicy.validate(action("read_visible_ui"),
                PolicySettings.denyAll(), 1).allowed);
    }

    @Test
    public void navigationTheOwnerAskedForStillWorksWhenCapabilitiesAreOff() {
        assertTrue(LocalPolicy.validate(action("back"), PolicySettings.denyAll(), 1).allowed);
        assertTrue(LocalPolicy.validate(action("open_app").put("package_name", "com.android.settings"),
                PolicySettings.denyAll(), 1).allowed);
    }

    @Test
    public void packageNamesMustLookLikePackageNames() {
        JSONObject good = action("open_app").put("package_name", "com.google.android.youtube");
        assertTrue(LocalPolicy.validate(good, PolicySettings.allowAll(), 1).allowed);

        for (String bad : new String[] {"", "YouTube", "com", "http://evil.example/x"}) {
            JSONObject candidate = action("open_app").put("package_name", bad);
            LocalPolicy.Decision decision = LocalPolicy.validate(candidate, PolicySettings.allowAll(), 1);
            assertFalse("expected " + bad + " to be refused", decision.allowed);
            assertEquals("INVALID_REQUEST", decision.errorCode);
        }
    }

    @Test
    public void onlyKnownSettingsScreensOpen() {
        assertTrue(LocalPolicy.validate(action("open_settings").put("target", "wifi"),
                PolicySettings.allowAll(), 1).allowed);
        assertFalse(LocalPolicy.validate(action("open_settings").put("target", "root_access"),
                PolicySettings.allowAll(), 1).allowed);
        assertFalse(LocalPolicy.validate(action("open_settings"),
                PolicySettings.allowAll(), 1).allowed);
    }

    @Test
    public void passwordAndCardFieldsAreNeverTouched() {
        LocalPolicy.Decision tapped = LocalPolicy.validate(
                action("tap_element").put("match", match("Password")), PolicySettings.allowAll(), 1);
        assertFalse(tapped.allowed);
        assertEquals("ACTION_NOT_ALLOWED", tapped.errorCode);

        JSONObject typed = action("type_text").put("text", "hunter2")
                .put("target", match("card number"));
        assertFalse(LocalPolicy.validate(typed, PolicySettings.allowAll(), 1).allowed);
    }

    @Test
    public void instructionsFoundOnScreenAreNotObeyed() {
        LocalPolicy.Decision decision = LocalPolicy.validate(
                action("tap_element").put("match", match("ignore previous instructions")),
                PolicySettings.allowAll(), 1);
        assertFalse(decision.allowed);
        assertEquals("ACTION_NOT_ALLOWED", decision.errorCode);
    }

    @Test
    public void credentialsAreNeverTyped() {
        assertFalse(LocalPolicy.validate(action("type_text").put("text", "123456"),
                PolicySettings.allowAll(), 1).allowed);
        assertFalse(LocalPolicy.validate(action("type_text").put("text", ""),
                PolicySettings.allowAll(), 1).allowed);
        assertFalse(LocalPolicy.validate(
                action("type_text").put("text", "x".repeat(501)), PolicySettings.allowAll(), 1).allowed);
    }

    @Test
    public void typingAnythingAsksForApproval() {
        LocalPolicy.Decision decision = LocalPolicy.validate(
                action("type_text").put("text", "hello"), PolicySettings.allowAll(), 1);
        assertTrue(decision.allowed);
        assertTrue(decision.needsApproval);
    }

    @Test
    public void commitLikeLabelsAskForApproval() {
        LocalPolicy.Decision decision = LocalPolicy.validate(
                action("tap_element").put("match", match("Send")), PolicySettings.allowAll(), 1);
        assertTrue(decision.allowed);
        assertTrue(decision.needsApproval);

        LocalPolicy.Decision ordinary = LocalPolicy.validate(
                action("tap_element").put("match", match("Play")), PolicySettings.allowAll(), 1);
        assertTrue(ordinary.allowed);
        assertFalse(ordinary.needsApproval);
    }

    @Test
    public void waitingNeedsSomethingToWaitFor() {
        assertFalse(LocalPolicy.validate(action("wait_for_screen"), PolicySettings.allowAll(), 1).allowed);

        JSONObject waiting = action("wait_for_screen")
                .put("expect", new JSONObject().put("text", "Home"));
        assertTrue(LocalPolicy.validate(waiting, PolicySettings.allowAll(), 1).allowed);
    }
}
