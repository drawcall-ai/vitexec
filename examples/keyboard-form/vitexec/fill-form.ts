import { keyboard, mouse } from "vitexec";

type Read<T> = () => T | undefined | null;

const waitFor = async <T>(read: Read<T>): Promise<T> => {
  for (let i = 0; i < 120; i += 1) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  throw new Error("Timed out waiting for keyboard form");
};

const typeText = async (element: HTMLInputElement | HTMLTextAreaElement, text: string): Promise<void> => {
  const box = element.getBoundingClientRect();
  await mouse.moveTo(box.x + box.width / 2, box.y + box.height / 2);
  await mouse.click();
  for (const character of text) {
    await keyboard.press(character, { durationMs: 40 });
  }
};

const title = await waitFor(() => document.querySelector<HTMLInputElement>("[data-title]"));
const email = await waitFor(() => document.querySelector<HTMLInputElement>("[data-email]"));
const message = await waitFor(() => document.querySelector<HTMLTextAreaElement>("[data-message]"));
const api = await waitFor(() => window.keyboardForm);

await typeText(title, "Launch checklist");
await typeText(email, "pilot@example.com");
await typeText(message, "Keyboard input drove this form.");
await keyboard.down("Control");
await keyboard.press("Enter");
await keyboard.up("Control");
await new Promise((resolve) => requestAnimationFrame(resolve));

console.log("keyboard-form", JSON.stringify(api.getSnapshot()));
