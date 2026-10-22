// Tells the page it is in rant-hmi-app, where its link to the HMI is the window's own scheme.
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("rantHmiApp", true);
