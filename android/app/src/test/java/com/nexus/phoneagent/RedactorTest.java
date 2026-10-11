package com.nexus.phoneagent;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import com.nexus.phoneagent.util.Redactor;

import org.junit.Test;

/** The redactor is the last line of defence before screen text leaves the phone. */
public class RedactorTest {

    @Test
    public void ordinaryTextIsLeftAlone() {
        assertEquals("Open YouTube", Redactor.redact("Open YouTube"));
        assertEquals("", Redactor.redact(null));
        assertEquals("", Redactor.redact("   "));
    }

    @Test
    public void passwordTextIsHidden() {
        assertEquals(Redactor.PLACEHOLDER, Redactor.redact("my password is hunter2"));
        assertEquals(Redactor.PLACEHOLDER, Redactor.redact("PIN"));
    }

    @Test
    public void emailsAndLongDigitRunsAreMasked() {
        assertTrue(Redactor.redact("write to a.person@example.com now").contains(Redactor.PLACEHOLDER));
        assertTrue(Redactor.redact("code 834615").contains(Redactor.PLACEHOLDER));
    }

    @Test
    public void credentialsAreRecognised() {
        assertTrue(Redactor.looksSensitive("123456"));
        assertTrue(Redactor.looksSensitive("password123"));
        assertTrue(Redactor.looksSensitive("card number 4111 1111 1111 1111"));
        assertFalse(Redactor.looksSensitive("Open YouTube"));
        assertFalse(Redactor.looksSensitive(""));
        assertFalse(Redactor.looksSensitive(null));
    }

    @Test
    public void secretFieldLabelsAreRecognised() {
        assertTrue(Redactor.isSensitiveFieldLabel("Password"));
        assertTrue(Redactor.isSensitiveFieldLabel("enter your pin"));
        assertTrue(Redactor.isSensitiveFieldLabel("CVV"));
        assertFalse(Redactor.isSensitiveFieldLabel("Search"));
        assertFalse(Redactor.isSensitiveFieldLabel(null));
    }

    @Test
    public void truncationKeepsMessagesShort() {
        assertEquals("abc", Redactor.truncate("abc", 10));
        assertEquals("abc" + '…', Redactor.truncate("abcdef", 3));
        assertEquals("", Redactor.truncate(null, 10));
    }
}
