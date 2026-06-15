@echo off
set JAVA_HOME=C:\Program Files\Android\Android Studio\jbr
set ANDROID_HOME=C:\Users\MyBook Z Series\AppData\Local\Android\Sdk
set PATH=%JAVA_HOME%\bin;%PATH%
cd /d "C:\Users\MyBook Z Series\Desktop\PalmAnnotate-Android\Migrasi"
call gradlew.bat assembleDebug --no-daemon 2>&1
