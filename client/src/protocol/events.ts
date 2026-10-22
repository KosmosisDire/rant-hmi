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
        "default": "true"
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
    ]
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
        "default": "true"
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
    ]
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
    ]
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
        "default": "500"
      },
      {
        "name": "while",
        "label": "While",
        "default": "true"
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
    ]
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
        "default": "100"
      },
      {
        "name": "while",
        "label": "While",
        "default": "true"
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
    ]
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
        "default": "true"
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
    ]
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
        "default": "true"
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
    ]
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
        "default": "true"
      }
    ],
    "brings": [
      [
        "value",
        "what was entered"
      ]
    ]
  }
];

export const SENT: readonly SettingInfo[] = [
  {
    "name": "while",
    "label": "While",
    "default": "true"
  }
];
