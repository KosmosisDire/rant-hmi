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
        "kind": "expression"
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
        "kind": "expression"
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
        "kind": "expression"
      },
      {
        "name": "while",
        "label": "While",
        "default": "true",
        "kind": "expression"
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
        "kind": "expression"
      },
      {
        "name": "while",
        "label": "While",
        "default": "true",
        "kind": "expression"
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
        "kind": "expression"
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
        "kind": "expression"
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
        "kind": "expression"
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
        "kind": "filter"
      },
      {
        "name": "code",
        "label": "Key code",
        "default": "any",
        "kind": "filter"
      },
      {
        "name": "while",
        "label": "While",
        "default": "true",
        "kind": "expression"
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
        "kind": "filter"
      },
      {
        "name": "code",
        "label": "Key code",
        "default": "any",
        "kind": "filter"
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
        "kind": "filter"
      },
      {
        "name": "code",
        "label": "Key code",
        "default": "any",
        "kind": "filter"
      },
      {
        "name": "every",
        "label": "Every ms",
        "default": "100",
        "kind": "expression"
      },
      {
        "name": "while",
        "label": "While",
        "default": "true",
        "kind": "expression"
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
  }
];

export const SENT: readonly SettingInfo[] = [
  {
    "name": "while",
    "label": "While",
    "default": "true",
    "kind": "expression"
  }
];
