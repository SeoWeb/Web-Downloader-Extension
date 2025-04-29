import { scrollToBottomAction } from "../../../client/actions/scrollToBottom/scrollToBottomAction";

export const scrollPageDown = async (sendHtmlToServer: (html: string) => Promise<void>) => {
    return await scrollToBottomAction(sendHtmlToServer);
};