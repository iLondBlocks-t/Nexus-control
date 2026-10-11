@rem
@rem NEXUS Gradle wrapper bootstrap (Windows).
@rem
@rem The wrapper JAR is a binary and is deliberately not committed here.
@rem Generate it once with:
@rem
@rem     gradle -p android wrapper --gradle-version 8.9 --distribution-type bin
@rem
@rem which writes the official gradlew, gradlew.bat and
@rem gradle/wrapper/gradle-wrapper.jar. See docs/ANDROID_SETUP.md.
@rem
@rem ------------------------------------------------------------------------

@echo off
setlocal

set DIR=%~dp0
set JAR=%DIR%gradle\wrapper\gradle-wrapper.jar

if not exist "%JAR%" (
  echo gradle-wrapper.jar is missing. 1>&2
  echo. 1>&2
  echo Generate it once with: 1>&2
  echo     gradle -p android wrapper --gradle-version 8.9 --distribution-type bin 1>&2
  echo. 1>&2
  echo See docs/ANDROID_SETUP.md for the full build instructions. 1>&2
  exit /b 2
)

if defined JAVA_HOME (
  set JAVACMD=%JAVA_HOME%\bin\java.exe
) else (
  set JAVACMD=java
)

"%JAVACMD%" -classpath "%JAR%" org.gradle.wrapper.GradleWrapperMain %*
exit /b %ERRORLEVEL%
