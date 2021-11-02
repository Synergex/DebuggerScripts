# DebuggerScripts
Repository to collect various scripts that help when debugging synergy programs
# WinDBG
### synergydbg.js setup
1. Load a dump file or live synergy process in WinDBG
2. .load jsprovider.dll
3. .scriptload PATH_TO_THE_EXTENSION_JS_FILE\synergydbg.js

### Features
*  !showHandles
*  !showChannels
*  !showTraceback
