import type { Attachment, AttachmentType, WorkItemAttachment } from './types.js';

export function attachmentsOfType<Type extends AttachmentType>(attachments: WorkItemAttachment[], type: Type): Array<Attachment<Type>> {
  return attachments.filter((attachment): attachment is Attachment<Type> => attachment.type === type);
}
