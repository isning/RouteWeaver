/** A source's newer task state replaces only its own informational feedback. */
export const sourceApplicationNoticeID = (sourceID: string) =>
  `source-application:${sourceID}`;
