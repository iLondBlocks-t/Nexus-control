@rem
@rem NEXUS Gradle wrapper bootstrap (Windows).
@rem
@rem A Gradle wrapper JAR is committed at gradle\wrapper\gradle-wrapper.jar, so
@rem gradlew.bat works out of the box: it downloads the Gradle distribution
@rem named in gradle-wrapper.properties (8.9) and runs the build with it.
@rem
@rem To regenerate it from an official Gradle installation instead:
@rem
@rem     gradle -p android wrapper --gradle-version 8.9 --distribution-type bin
@rem
@rem See docs/ANDROID_SETUP.md.
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

"%JAVACMD%" -classpath "%JAR%" -Dorg.gradle.appname=gradlew org.gradle.wrapper.GradleWrapperMain %*
exit /b %ERRORLEVEL%
