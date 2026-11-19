/** 用户随消息发的附件在消息上的引用（存在 messages.attachments 列；内容在受管副本里，见 attachments/service.ts）。 */
export type AttachmentKind = "image" | "text";

export interface MessageAttachment {
  /** 不可猜的附件 id */
  id: string;
  kind: AttachmentKind;
  /** 文件名（只用于显示；图片的原名不给界面） */
  name: string;
  /** 原始字节数 */
  size: number;
  /** 内容版本：之后的回合、预览按它重读同一份 */
  version: string;
  /** 图片规范化后的尺寸 */
  width?: number;
  height?: number;
}
