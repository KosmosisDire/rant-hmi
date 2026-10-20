import { remembered } from "./remember";

const [theme, setTheme] = remembered("theme", "dark", ["dark", "light"] as const);
document.documentElement.dataset.theme = theme();

export { theme };

export function toggleTheme() {
  const next = theme() === "dark" ? "light" : "dark";
  setTheme(next);
  document.documentElement.dataset.theme = next;
}
