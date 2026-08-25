# supersession.tape — regenerates docs/demo/supersession.gif
#
#   vhs docs/demo/supersession.tape
#
# Requires vhs (https://github.com/charmbracelet/vhs), Node 22, and a built
# tree (`npm run build`). The demo itself is examples/supersession/demo.mjs.

Output docs/demo/supersession.gif

Set Shell bash
Set FontSize 15
Set Width 1180
Set Height 760
Set Padding 22
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms
Set PlaybackSpeed 1.0

Sleep 900ms
Type "node examples/supersession/demo.mjs"
Sleep 700ms
Enter

# The demo paces itself via DEMO_PACE (set in the wrapper below); this sleep
# just has to outlast it.
Sleep 42s
