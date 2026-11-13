import { projectHref } from "../lib/route";
import { DELETED_PROJECT, useProject } from "../lib/store";

/** 会话接入的研究项目名：点了去项目页。项目已从 Bunsen 删除时显示“（已删除的项目）”，会话照常运行。 */
export function ProjectName({ id }: { id: string }) {
  const ref = useProject(id);
  if (ref === "pending") return <span className="dim mono">{id}</span>;
  if (ref === "deleted") {
    return (
      <span className="dim" title={`项目 ${id} 已从 Bunsen 删除`}>
        {DELETED_PROJECT}
      </span>
    );
  }
  return (
    <a href={projectHref(ref.id)} title={`研究项目 · ${ref.branch}`}>
      {ref.name}
    </a>
  );
}
