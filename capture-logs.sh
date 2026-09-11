#!/usr/bin/env bash
# VelChat realtime diagnostic. Plug the phone in (USB debugging on), then run:
#     bash capture-logs.sh
# Then, WHILE IT RUNS: open the app, open a chat, and have the other phone send you a message.
PKG=${1:-com.velchat}
echo "== device =="; adb devices | tail -2
echo "== watching $PKG for 60s — use the app NOW =="
adb logcat -c
adb shell am force-stop "$PKG"
adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
timeout 60 adb logcat -s ReactNativeJS:V 2>/dev/null \
  | grep -viE "\"level\":(10|20)" \
  | grep -iE "backend base|ws open|ws closed|ws error|ws reconnect|unauthorized|session|connected|receipt|delivered|read|presence|outbox|send\.|recv\.|apply|sync|backfill|error|warn" \
  | tee /tmp/velchat-diag.txt
echo
echo "== summary =="
for k in "ws open" "ws closed" "unauthorized" "session established" "receipt" "presence"; do
  printf "  %-22s %s\n" "$k" "$(grep -ci "$k" /tmp/velchat-diag.txt)"
done
echo "full log: /tmp/velchat-diag.txt"
