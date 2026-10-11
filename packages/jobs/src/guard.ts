import type { JobSubject, Queryable, SubjectState, SubjectVersionGuard } from "./types";

function subjectKey(type: string, id: string): string {
  return JSON.stringify([type, id]);
}

export class InMemorySubjectVersionGuard implements SubjectVersionGuard {
  private readonly currentVersions = new Map<string, number>();
  private readonly deletedSubjects = new Set<string>();

  setCurrent(type: string, id: string, version: number): void {
    this.currentVersions.set(subjectKey(type, id), version);
    this.deletedSubjects.delete(subjectKey(type, id));
  }

  markDeleted(type: string, id: string): void {
    this.deletedSubjects.add(subjectKey(type, id));
    this.currentVersions.delete(subjectKey(type, id));
  }

  async check(subject: JobSubject, _tx: Queryable): Promise<SubjectState> {
    void _tx;
    const key = subjectKey(subject.type, subject.id);
    if (this.deletedSubjects.has(key)) return "DELETED";
    const currentVersion = this.currentVersions.get(key);
    if (currentVersion === undefined) return "DELETED";
    return currentVersion === subject.version ? "CURRENT" : "SUPERSEDED";
  }
}
