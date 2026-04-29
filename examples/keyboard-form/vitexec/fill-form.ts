type Read<T> = () => T | undefined | null;

export {};

const waitFor = async <T>(read: Read<T>): Promise<T> => {
  for (let i = 0; i < 120; i += 1) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  throw new Error("Timed out waiting for keyboard form");
};

const typeText = async (element: HTMLInputElement | HTMLTextAreaElement, text: string): Promise<void> => {
  element.focus();
  for (const character of text) {
    element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: character }));
    element.value += character;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, data: character, inputType: "insertText" }));
    element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: character }));
  }
};

const title = await waitFor(() => document.querySelector<HTMLInputElement>("[data-title]"));
const email = await waitFor(() => document.querySelector<HTMLInputElement>("[data-email]"));
const message = await waitFor(() => document.querySelector<HTMLTextAreaElement>("[data-message]"));
const api = await waitFor(() => window.keyboardForm);

await typeText(title, "Launch checklist");
await typeText(email, "pilot@example.com");
await typeText(message, "Keyboard input drove this form.");
window.dispatchEvent(new KeyboardEvent("keydown", {
  bubbles: true,
  code: "Enter",
  ctrlKey: true,
  key: "Enter"
}));
await new Promise((resolve) => requestAnimationFrame(resolve));

console.log("keyboard-form", JSON.stringify(api.getSnapshot()));
