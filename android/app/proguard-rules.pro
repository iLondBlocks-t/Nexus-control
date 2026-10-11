# NEXUS Phone Agent release rules.
#
# Nothing is obfuscated on purpose: the app contains no third party SDKs and the
# owner should be able to read a stack trace from their own device.
-dontobfuscate
-keepattributes SourceFile,LineNumberTable
-keep class com.nexus.phoneagent.** { *; }
