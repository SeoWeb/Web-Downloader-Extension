import { Message, ResponseMessage } from "../../types/message";

let i: any = null;
export async function sendMessage(
  message: Message,
) {
  if (i) {
    clearTimeout(i);
  }

  const fn = async () => {
    return await chrome.runtime.sendMessage(message);
  };

  return new Promise<ResponseMessage>((resolve) => {
    i = setTimeout(() => {
      fn().then(resolve);
    }, 100);
  });
}
