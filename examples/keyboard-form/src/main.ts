import "./style.css";

type FormSnapshot = {
  email: string;
  message: string;
  submitted: boolean;
  title: string;
};

declare global {
  interface Window {
    keyboardForm?: {
      getSnapshot: () => FormSnapshot;
    };
  }
}

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing #app element.");
}

app.innerHTML = `
  <form class="form-shell" data-form>
    <label>
      Title
      <input data-title name="title" autocomplete="off" />
    </label>
    <label>
      Email
      <input data-email name="email" type="email" autocomplete="off" />
    </label>
    <label>
      Message
      <textarea data-message name="message"></textarea>
    </label>
    <button type="submit">Send</button>
    <output data-status>Draft</output>
  </form>
`;

const form = app.querySelector<HTMLFormElement>("[data-form]");
const title = app.querySelector<HTMLInputElement>("[data-title]");
const email = app.querySelector<HTMLInputElement>("[data-email]");
const message = app.querySelector<HTMLTextAreaElement>("[data-message]");
const status = app.querySelector<HTMLOutputElement>("[data-status]");

if (!form || !title || !email || !message || !status) {
  throw new Error("Keyboard form failed to initialize.");
}

let submitted = false;

form.addEventListener("submit", (event) => {
  event.preventDefault();
  submitted = true;
  status.value = "Submitted";
});

window.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.code === "Enter") {
    event.preventDefault();
    form.requestSubmit();
  }
});

window.keyboardForm = {
  getSnapshot: () => ({
    email: email.value,
    message: message.value,
    submitted,
    title: title.value
  })
};
