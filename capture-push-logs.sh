#!/usr/bin/env bash
# VelChat PUSH diagnostic — answers "why did no notification arrive?" without guessing.
#
# The existing capture-logs.sh watches ReactNativeJS only, which cannot see the part that
# matters: a push for a CLOSED app is handled entirely in Kotlin, so the token, the notification
# post and the delivery ack never touch JS. This captures both sides.
#
# Usage — pick the mode that matches what you are testing:
#
#   bash capture-push-logs.sh open     app STAYS OPEN. Checks registration: does the device get
#                                      an FCM token and does the backend accept it?
#
#   bash capture-push-logs.sh closed   app is FORCE-STOPPED, then you send it a message from the
#                                      other phone. This is the real test: notification + the
#                                      delivery ack that turns the sender's tick to two.
#
# Nothing here needs the app to be rebuilt, and it prints no tokens.
set -uo pipefail

MODE=${1:-open}
PKG=${2:-com.velchat}
OUT=${OUT:-./push-diag.txt}

command -v adb >/dev/null || { echo "adb not on PATH"; exit 1; }

DEV=$(adb devices | awk 'NR>1 && $2=="device"{print $1; exit}')
[ -n "$DEV" ] || { echo "No device. Plug the phone in, enable USB debugging, and accept the prompt."; exit 1; }
echo "device: $DEV"
echo "package: $PKG"
echo "mode: $MODE"
echo

# Everything the push path can say, native and JS. `-s TAG:V` keeps the volume survivable on a
# phone that is also logging its OEM's usual noise.
TAGS=(
  VelChatPush:V          # messaging service: token rotation, push received, ack outcome
  VelChatPushAck:V       # the HTTP ack itself, including the refusal status
  VelChatPushAction:V    # reply / mark-as-read / mute from the notification
  VelChatPushBridge:V    # whether a JS runtime was alive to hand the push to
  VelChatPushHeadless:V  # the reply path booting JS
  FirebaseMessaging:V    # the SDK's own view: was the message even delivered to this device?
  ReactNativeJS:V        # the JS side (registration, availability, sync)
)

adb -s "$DEV" logcat -c

case "$MODE" in
  closed)
    echo "Force-stopping $PKG. Do NOT open it."
    adb -s "$DEV" shell am force-stop "$PKG"
    echo
    echo ">>> NOW: send this phone a message from the other phone. Watching 90s."
    WATCH=90
    ;;
  open)
    echo ">>> NOW: open the app (log in if it asks). Watching 90s."
    adb -s "$DEV" shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
    WATCH=90
    ;;
  *)
    echo "Unknown mode '$MODE'. Use: open | closed"; exit 1 ;;
esac

echo
# `-v time` so the ordering of "push received" vs "ack" is readable, which is the whole question.
timeout "$WATCH" adb -s "$DEV" logcat -v time "${TAGS[@]}" '*:S' 2>/dev/null \
  | grep -viE '"level":(10|20)' \
  | tee "$OUT"

echo
echo "================ summary ================"
# Each line below is a specific question someone has had to guess at during this feature.
check() { printf '  %-42s %s\n' "$1" "$(grep -ciE "$2" "$OUT" 2>/dev/null || echo 0)"; }
check "FCM token obtained"                 "registration token|push registered|token rotated"
check "backend accepted registration"      "push registered with backend"
check "push availability -> true"          "availability changed.*true|\"available\":true"
check "push message RECEIVED by device"    "onMessageReceived|push received|MessageReceived"
check "notification posted"                "notification post|showMessage"
check "delivery ack sent OK"               "ack accepted|device ack published"
check "delivery ack FAILED"                "ack refused|ack failed|ack skipped|not accepted"
check "notification action taken"          "VelChatPushAction"
check "errors"                             '"level":50|level":"error"|FATAL|Exception'
echo
echo "full log: $OUT"
echo
echo "Read it like this:"
echo "  0 'push message RECEIVED'  -> the push never reached the phone. Server side:"
echo "                               curl -s https://velchat.duckdns.org/notifications/push-status"
echo "                               (needs delivers:true) and check the recipient was OFFLINE —"
echo "                               the server skips push for a user it thinks is connected."
echo "  RECEIVED but 0 'notification posted' -> notifications are off for the app, or the chat is muted."
echo "  RECEIVED, posted, but 'ack FAILED'   -> the second tick cannot arrive; the line gives the HTTP status."
