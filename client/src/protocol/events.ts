// Written by the backend's tests from server/src/events.rs, where they change.

import type { EventInfo } from "./EventInfo";
import type { SettingInfo } from "./SettingInfo";

export const EVENTS: readonly EventInfo[] = [
  {
    "name": "tap",
    "from": "pointer",
    "words": "pressed and let go on it",
    "once": true,
    "settings": [
      {
        "name": "while",
        "label": "While",
        "default": "true",
        "kind": "expression",
        "options": []
      }
    ],
    "brings": [
      [
        "x",
        "across it, 0 to 1"
      ],
      [
        "y",
        "down it, 0 to 1"
      ],
      [
        "angle",
        "degrees around its centre, 0 up"
      ],
      [
        "on",
        "the part pressed, by name"
      ],
      [
        "inside",
        "true while over it"
      ]
    ],
    "ends_with": null
  },
  {
    "name": "press",
    "from": "pointer",
    "words": "pressed down",
    "once": true,
    "settings": [
      {
        "name": "while",
        "label": "While",
        "default": "true",
        "kind": "expression",
        "options": []
      }
    ],
    "brings": [
      [
        "x",
        "across it, 0 to 1"
      ],
      [
        "y",
        "down it, 0 to 1"
      ],
      [
        "angle",
        "degrees around its centre, 0 up"
      ],
      [
        "on",
        "the part pressed, by name"
      ],
      [
        "inside",
        "true while over it"
      ]
    ],
    "ends_with": "release"
  },
  {
    "name": "release",
    "from": "pointer",
    "words": "let go, anywhere",
    "once": true,
    "settings": [],
    "brings": [
      [
        "x",
        "across it, 0 to 1"
      ],
      [
        "y",
        "down it, 0 to 1"
      ],
      [
        "angle",
        "degrees around its centre, 0 up"
      ],
      [
        "on",
        "the part pressed, by name"
      ],
      [
        "inside",
        "true while over it"
      ]
    ],
    "ends_with": null
  },
  {
    "name": "hold",
    "from": "pointer",
    "words": "held down a while",
    "once": true,
    "settings": [
      {
        "name": "after",
        "label": "After ms",
        "default": "500",
        "kind": "expression",
        "options": []
      },
      {
        "name": "while",
        "label": "While",
        "default": "true",
        "kind": "expression",
        "options": []
      }
    ],
    "brings": [
      [
        "x",
        "across it, 0 to 1"
      ],
      [
        "y",
        "down it, 0 to 1"
      ],
      [
        "angle",
        "degrees around its centre, 0 up"
      ],
      [
        "on",
        "the part pressed, by name"
      ],
      [
        "inside",
        "true while over it"
      ]
    ],
    "ends_with": null
  },
  {
    "name": "repeat",
    "from": "pointer",
    "words": "again and again while pressed",
    "once": true,
    "settings": [
      {
        "name": "every",
        "label": "Every ms",
        "default": "100",
        "kind": "expression",
        "options": []
      },
      {
        "name": "while",
        "label": "While",
        "default": "true",
        "kind": "expression",
        "options": []
      }
    ],
    "brings": [
      [
        "x",
        "across it, 0 to 1"
      ],
      [
        "y",
        "down it, 0 to 1"
      ],
      [
        "angle",
        "degrees around its centre, 0 up"
      ],
      [
        "on",
        "the part pressed, by name"
      ],
      [
        "inside",
        "true while over it"
      ]
    ],
    "ends_with": null
  },
  {
    "name": "drag",
    "from": "pointer",
    "words": "moved while pressed",
    "once": false,
    "settings": [
      {
        "name": "while",
        "label": "While",
        "default": "true",
        "kind": "expression",
        "options": []
      }
    ],
    "brings": [
      [
        "x",
        "across it, 0 to 1"
      ],
      [
        "y",
        "down it, 0 to 1"
      ],
      [
        "angle",
        "degrees around its centre, 0 up"
      ],
      [
        "on",
        "the part pressed, by name"
      ],
      [
        "inside",
        "true while over it"
      ]
    ],
    "ends_with": null
  },
  {
    "name": "outside",
    "from": "pointer",
    "words": "a press anywhere else",
    "once": true,
    "settings": [
      {
        "name": "while",
        "label": "While",
        "default": "true",
        "kind": "expression",
        "options": []
      }
    ],
    "brings": [
      [
        "x",
        "across it, 0 to 1"
      ],
      [
        "y",
        "down it, 0 to 1"
      ],
      [
        "angle",
        "degrees around its centre, 0 up"
      ],
      [
        "on",
        "the part pressed, by name"
      ],
      [
        "inside",
        "true while over it"
      ]
    ],
    "ends_with": null
  },
  {
    "name": "change",
    "from": "entry",
    "words": "a value entered",
    "once": false,
    "settings": [
      {
        "name": "while",
        "label": "While",
        "default": "true",
        "kind": "expression",
        "options": []
      }
    ],
    "brings": [
      [
        "value",
        "what was entered"
      ]
    ],
    "ends_with": null
  },
  {
    "name": "keydown",
    "from": "keyboard",
    "words": "a key pressed",
    "once": true,
    "settings": [
      {
        "name": "key",
        "label": "Key",
        "default": "any",
        "kind": "filter",
        "options": []
      },
      {
        "name": "code",
        "label": "Key code",
        "default": "any",
        "kind": "filter",
        "options": []
      },
      {
        "name": "while",
        "label": "While",
        "default": "true",
        "kind": "expression",
        "options": []
      }
    ],
    "brings": [
      [
        "key",
        "what it types, as \"a\" or \"Enter\""
      ],
      [
        "code",
        "where it sits, as \"KeyA\""
      ],
      [
        "shift",
        "true while Shift is down"
      ],
      [
        "ctrl",
        "true while Ctrl is down"
      ],
      [
        "alt",
        "true while Alt is down"
      ]
    ],
    "ends_with": "keyup"
  },
  {
    "name": "keyup",
    "from": "keyboard",
    "words": "a key let go",
    "once": true,
    "settings": [
      {
        "name": "key",
        "label": "Key",
        "default": "any",
        "kind": "filter",
        "options": []
      },
      {
        "name": "code",
        "label": "Key code",
        "default": "any",
        "kind": "filter",
        "options": []
      }
    ],
    "brings": [
      [
        "key",
        "what it types, as \"a\" or \"Enter\""
      ],
      [
        "code",
        "where it sits, as \"KeyA\""
      ],
      [
        "shift",
        "true while Shift is down"
      ],
      [
        "ctrl",
        "true while Ctrl is down"
      ],
      [
        "alt",
        "true while Alt is down"
      ]
    ],
    "ends_with": null
  },
  {
    "name": "keyrepeat",
    "from": "keyboard",
    "words": "again and again while a key is down",
    "once": true,
    "settings": [
      {
        "name": "key",
        "label": "Key",
        "default": "any",
        "kind": "filter",
        "options": []
      },
      {
        "name": "code",
        "label": "Key code",
        "default": "any",
        "kind": "filter",
        "options": []
      },
      {
        "name": "every",
        "label": "Every ms",
        "default": "100",
        "kind": "expression",
        "options": []
      },
      {
        "name": "while",
        "label": "While",
        "default": "true",
        "kind": "expression",
        "options": []
      }
    ],
    "brings": [
      [
        "key",
        "what it types, as \"a\" or \"Enter\""
      ],
      [
        "code",
        "where it sits, as \"KeyA\""
      ],
      [
        "shift",
        "true while Shift is down"
      ],
      [
        "ctrl",
        "true while Ctrl is down"
      ],
      [
        "alt",
        "true while Alt is down"
      ]
    ],
    "ends_with": null
  },
  {
    "name": "buttondown",
    "from": "gamepad",
    "words": "a gamepad button pressed",
    "once": true,
    "settings": [
      {
        "name": "button",
        "label": "Button",
        "default": "any",
        "kind": "filter",
        "options": [
          [
            "south",
            "A, Cross"
          ],
          [
            "east",
            "B, Circle"
          ],
          [
            "west",
            "X, Square"
          ],
          [
            "north",
            "Y, Triangle"
          ],
          [
            "lb",
            "left bumper, L1"
          ],
          [
            "rb",
            "right bumper, R1"
          ],
          [
            "lt",
            "left trigger, L2"
          ],
          [
            "rt",
            "right trigger, R2"
          ],
          [
            "back",
            "Back, Share"
          ],
          [
            "start",
            "Start, Options"
          ],
          [
            "ls",
            "left stick pressed"
          ],
          [
            "rs",
            "right stick pressed"
          ],
          [
            "up",
            "pad up"
          ],
          [
            "down",
            "pad down"
          ],
          [
            "left",
            "pad left"
          ],
          [
            "right",
            "pad right"
          ],
          [
            "home",
            "Guide, PS"
          ]
        ]
      },
      {
        "name": "pad",
        "label": "Pad",
        "default": "any",
        "kind": "filter",
        "options": [
          [
            "0",
            "the first"
          ],
          [
            "1",
            "the second"
          ],
          [
            "2",
            "the third"
          ],
          [
            "3",
            "the fourth"
          ]
        ]
      },
      {
        "name": "while",
        "label": "While",
        "default": "true",
        "kind": "expression",
        "options": []
      }
    ],
    "brings": [
      [
        "button",
        "which, by where it sits, as \"south\""
      ],
      [
        "pad",
        "which pad, 0 for the first"
      ]
    ],
    "ends_with": "buttonup"
  },
  {
    "name": "buttonup",
    "from": "gamepad",
    "words": "a gamepad button let go",
    "once": true,
    "settings": [
      {
        "name": "button",
        "label": "Button",
        "default": "any",
        "kind": "filter",
        "options": [
          [
            "south",
            "A, Cross"
          ],
          [
            "east",
            "B, Circle"
          ],
          [
            "west",
            "X, Square"
          ],
          [
            "north",
            "Y, Triangle"
          ],
          [
            "lb",
            "left bumper, L1"
          ],
          [
            "rb",
            "right bumper, R1"
          ],
          [
            "lt",
            "left trigger, L2"
          ],
          [
            "rt",
            "right trigger, R2"
          ],
          [
            "back",
            "Back, Share"
          ],
          [
            "start",
            "Start, Options"
          ],
          [
            "ls",
            "left stick pressed"
          ],
          [
            "rs",
            "right stick pressed"
          ],
          [
            "up",
            "pad up"
          ],
          [
            "down",
            "pad down"
          ],
          [
            "left",
            "pad left"
          ],
          [
            "right",
            "pad right"
          ],
          [
            "home",
            "Guide, PS"
          ]
        ]
      },
      {
        "name": "pad",
        "label": "Pad",
        "default": "any",
        "kind": "filter",
        "options": [
          [
            "0",
            "the first"
          ],
          [
            "1",
            "the second"
          ],
          [
            "2",
            "the third"
          ],
          [
            "3",
            "the fourth"
          ]
        ]
      }
    ],
    "brings": [
      [
        "button",
        "which, by where it sits, as \"south\""
      ],
      [
        "pad",
        "which pad, 0 for the first"
      ]
    ],
    "ends_with": null
  },
  {
    "name": "axes",
    "from": "gamepad",
    "words": "a gamepad's sticks or triggers moved",
    "once": false,
    "settings": [
      {
        "name": "pad",
        "label": "Pad",
        "default": "any",
        "kind": "filter",
        "options": [
          [
            "0",
            "the first"
          ],
          [
            "1",
            "the second"
          ],
          [
            "2",
            "the third"
          ],
          [
            "3",
            "the fourth"
          ]
        ]
      },
      {
        "name": "deadband",
        "label": "Deadband",
        "default": "0.1",
        "kind": "expression",
        "options": []
      },
      {
        "name": "while",
        "label": "While",
        "default": "true",
        "kind": "expression",
        "options": []
      }
    ],
    "brings": [
      [
        "lx",
        "the left stick across, -1 to 1"
      ],
      [
        "ly",
        "the left stick up, -1 to 1"
      ],
      [
        "rx",
        "the right stick across, -1 to 1"
      ],
      [
        "ry",
        "the right stick up, -1 to 1"
      ],
      [
        "lt",
        "the left trigger, 0 to 1"
      ],
      [
        "rt",
        "the right trigger, 0 to 1"
      ],
      [
        "axes",
        "every axis as the pad gives it, down positive"
      ],
      [
        "pad",
        "which pad, 0 for the first"
      ]
    ],
    "ends_with": "axes"
  }
];

export const SENT: readonly SettingInfo[] = [
  {
    "name": "while",
    "label": "While",
    "default": "true",
    "kind": "expression",
    "options": []
  }
];
