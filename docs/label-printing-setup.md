# Printing labels from a PC (Xprinter XP-365B, 50 x 22 mm labels)

No software besides the printer's driver goes on the PC. Nothing in Chrome or the system needs changing.

## One-time setup on each PC

1. Install the Xprinter XP-365B driver for the PC's system (Windows or macOS) and connect the printer by USB.
2. Add a paper size named `label 50x22`: width 50 mm, height 22 mm, all margins 0.
   - Mac: in any print window choose Paper Size > Manage Custom Sizes > `+`.
   - Windows: Printer properties > Printing Preferences > add or select the 50 x 22 mm size.
3. Orientation is Portrait and scale is 100%.
4. Save these settings as a preset named `Consumable` (Mac: Presets > Save Current Settings as Preset). On Windows,
   save them as the printer's default in Printing Preferences.

## Printing labels

1. Click **Open PDF** next to the labels. The PDF opens in a new tab. Check the labels.
2. Open the system print window, **not** Chrome's own one:
   - Mac: press ⌥⌘P.
   - Windows: press Ctrl+Shift+P.
   - Or press the print icon in the PDF, then click **Print using system dialogue** at the bottom of Chrome's window.
3. Check the printer is the Xprinter, the paper size is `label 50x22` (the `Consumable` preset sets this), and Portrait.
   Click **Print**.

## Printing issue labels from the extension panel

The extension's side panel no longer prints by itself and needs no QZ Tray or print helper.

1. Issue the bottle. Click **Open label** (or **Issue from stock and open label**, which opens it straight away).
   The label PDF opens in a new Chrome tab. When several bottles were issued, each label opens in its own tab.
2. Check the label, then print it as in "Printing labels" above (⌥⌘P on Mac, Ctrl+Shift+P on Windows, then **Print**).

## Why not Chrome's own print window (Ctrl+P)

On a Mac, Chrome's own print window always sends this driver a page 22 mm across and 50 mm long. The label then prints
turned, or shrunk and two labels long. The system window sends the page as it is. This was tested on a Mac. It has
not been tested on Windows yet: if Ctrl+P prints correctly there, it can be used instead.

## If a label comes out wrong

| What you see | What to check |
| --- | --- |
| Turned sideways, spread over two labels | Printed from Chrome's own window. Use the system window (step 2). |
| Small | Scale is not 100%, or the paper size is wrong. |
| A blank label before or after each one | The paper height is not 22 mm. |
| Shifted to one side | Margins are not 0. |
