//! 镜像端唯一需要复现的 rk 规则：结论文件、空白、复核覆盖与 fail 关闭。
use super::{blob_text, repo_path, time_key, Tree};
use crate::model::{Project, ProjectLine, ProjectTrust};
use crate::research_quality::{quality_version, rk_version};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

fn relative<'a>(home: &str, file: &'a str) -> Option<&'a str> {
    if home == "." {
        Some(file)
    } else {
        file.strip_prefix(home)?.strip_prefix('/')
    }
}
fn direct(file: &str, dir: &str, suffix: &str) -> bool {
    file.strip_prefix(dir).is_some_and(|s| !s.contains('/') && s.ends_with(suffix))
}
fn template(file: &str) -> Option<&'static str> {
    match file {
        "SUMMARY.md" => Some("SUMMARY.md"),
        "OVERVIEW.md" => Some("OVERVIEW.md"),
        "LEDGER.md" => Some("LEDGER.md"),
        _ if direct(file, "results/", ".md") && file != "results/TEMPLATE.md" => Some("results/TEMPLATE.md"),
        _ if direct(file, "strategy/", ".md") && file != "strategy/TEMPLATE.md" => Some("strategy/TEMPLATE.md"),
        _ => None,
    }
}
pub(super) fn needed(home: &str, file: &str) -> bool {
    relative(home, file).is_some_and(|f| {
        f == "tools/rk.py"
            || template(f).is_some()
            || direct(f, "audits/review-", ".json")
            || direct(f, "audits/resolve-", ".json")
            || direct(f, "sources/", ".json")
    })
}

pub(super) fn conclusion(home: &str, path: &str) -> bool {
    relative(home, path).is_some_and(|file| template(file).is_some())
}

pub(super) fn reviewed_paths(home: &str, tree: &Tree, blobs: &BTreeMap<String, Vec<u8>>) -> BTreeSet<String> {
    let mut reviewed = BTreeSet::new();
    for path in tree.keys().filter(|p| relative(home, p).is_some_and(|f| direct(f, "audits/review-", ".json"))) {
        let Some(record) = blob_text(tree, blobs, path).and_then(|s| serde_json::from_str::<Value>(s).ok()) else { continue };
        if record["kind"] != "review" {
            continue;
        }
        if let Some(files) = record["files"].as_array() {
            for file in files {
                if let (Some(path), Some(hash)) = (file["path"].as_str(), file["git_blob"].as_str()) {
                    let path = repo_path(home, path);
                    if tree.get(&path).is_some_and(|current| current == hash) {
                        reviewed.insert(path);
                    }
                }
            }
        }
    }
    reviewed
}

fn blank(file: &str, text: &str) -> bool {
    let Some(name) = template(file) else { return false };
    let Some(original) = crate::plugins::research_template(name) else { return false };
    let templates: BTreeSet<_> = original.lines().map(str::trim_end).collect();
    let mut table = false;
    for line in text.lines().map(str::trim_end) {
        let trimmed = line.trim_start();
        let cells = trimmed.strip_prefix('|').and_then(|s| s.strip_suffix('|')).map(|s| s.split('|').map(str::trim).collect::<Vec<_>>());
        let header = cells.is_some() && !table;
        table = cells.is_some();
        if trimmed.is_empty() || line.starts_with('#') || line.starts_with("<!--") || templates.contains(line) || header {
            continue;
        }
        if let Some(cells) = cells {
            let separator = cells.iter().all(|c| {
                c.trim_matches(':').len() >= 2
                    && c.trim_matches(':').chars().all(|x| x == '-')
                    && c.chars().filter(|x| *x == ':').count() <= 2
                    && !c.contains("::")
            });
            if separator || cells.iter().all(|c| c.is_empty() || placeholder(c)) {
                continue;
            }
        }
        let content = trimmed
            .strip_prefix(['-', '*', '+'])
            .filter(|s| s.starts_with(char::is_whitespace))
            .or_else(|| {
                let end = trimmed.find(['.', ')'])?;
                let (number, rest) = trimmed.split_at(end);
                (!number.is_empty() && number.bytes().all(|b| b.is_ascii_digit()) && rest[1..].starts_with(char::is_whitespace))
                    .then_some(&rest[1..])
            })
            .unwrap_or(trimmed)
            .trim_start();
        if !placeholder(content) {
            return false;
        }
    }
    true
}
fn placeholder(text: &str) -> bool {
    text.starts_with('<') && text.ends_with('>')
}

pub(super) fn derive(
    project: &Project,
    trees: &BTreeMap<String, Tree>,
    blobs: &BTreeMap<String, Vec<u8>>,
    lines: &mut [ProjectLine],
) -> Option<ProjectTrust> {
    let tree = trees.get(&project.branch)?;
    let version = rk_version(blob_text(tree, blobs, &repo_path(&project.home, "tools/rk.py"))?)?;
    if !quality_version(&version) {
        return None;
    }
    let mut reviews = Vec::new();
    let mut closed = BTreeSet::new();
    let mut sources = BTreeMap::<String, Value>::new();
    for path in tree.keys() {
        let Some(file) = relative(&project.home, path) else { continue };
        if !direct(file, "audits/review-", ".json") && !direct(file, "audits/resolve-", ".json") && !direct(file, "sources/", ".json") {
            continue;
        }
        let Some(value) = blob_text(tree, blobs, path).and_then(|s| serde_json::from_str::<Value>(s).ok()).filter(Value::is_object) else {
            continue;
        };
        match value["kind"].as_str() {
            Some("review") if direct(file, "audits/review-", ".json") => {
                if let Some(items) = value["items"].as_array() {
                    for item in items {
                        if item["verdict"] == "pass" {
                            if let Some(reference) = item["resolves"].as_str() {
                                closed.insert(reference.to_string());
                            }
                        }
                    }
                }
                // 记录的 id 按契约就是文件名；不相信正文里的另一份 id。
                reviews.push((file.trim_start_matches("audits/").trim_end_matches(".json").to_string(), value));
            }
            Some("resolve") if direct(file, "audits/resolve-", ".json") => {
                if let Some(reference) = value["item"].as_str() {
                    closed.insert(reference.to_string());
                }
            }
            _ if direct(file, "sources/", ".json") => {
                if let Some(id) = value["id"].as_str() {
                    let checked = value["checked_at"].as_str().and_then(time_key);
                    if checked.is_some() && sources.get(id).is_none_or(|old| checked > old["checked_at"].as_str().and_then(time_key)) {
                        sources.insert(id.to_string(), value);
                    }
                }
            }
            _ => (),
        }
    }
    let mut reviewed = BTreeSet::new();
    for (_, record) in &reviews {
        if let Some(files) = record["files"].as_array() {
            for file in files {
                if let (Some(path), Some(blob)) = (file["path"].as_str(), file["git_blob"].as_str()) {
                    reviewed.insert((path, blob));
                }
            }
        }
    }
    let mut counts = ProjectTrust::default();
    let mut by_line = BTreeMap::<String, (usize, usize)>::new();
    let line_for = |file: &str| -> Option<String> {
        let id = file.strip_prefix("results/")?.strip_suffix(".md")?;
        if id.contains('/') {
            return None;
        }
        // 只用研究分支的 meta，不能用视图里可能来自未并入 sync 分支的运行。
        let meta: Value = serde_json::from_str(blob_text(tree, blobs, &repo_path(&project.home, &format!("runs/{id}/meta.json")))?).ok()?;
        meta["line"].as_str().filter(|s| !s.is_empty()).map(str::to_string)
    };
    for (path, hash) in tree {
        let Some(file) = relative(&project.home, path).filter(|f| template(f).is_some()) else { continue };
        if reviewed.contains(&(file, hash.as_str())) {
            continue;
        }
        if let Some(text) = blob_text(tree, blobs, path) {
            if !blank(file, text) {
                counts.unreviewed += 1;
                if let Some(line) = line_for(file) {
                    by_line.entry(line).or_default().1 += 1;
                }
            }
        }
    }
    for (id, record) in &reviews {
        if let Some(items) = record["items"].as_array() {
            for item in items {
                if item["verdict"] != "fail" {
                    continue;
                }
                let (Some(item_id), Some(file)) = (item["id"].as_str(), item["file"].as_str()) else { continue };
                if !closed.contains(&format!("{id}#{item_id}")) {
                    counts.open_fails += 1;
                    if let Some(line) = line_for(file) {
                        by_line.entry(line).or_default().0 += 1;
                    }
                }
            }
        }
    }
    for source in sources.values() {
        if source["status"] == "not_found" {
            counts.unresolved_citations += 1;
        }
        if source["status"] == "ok" && source["retracted"] == true {
            counts.retracted_citations += 1;
        }
    }
    for line in lines {
        let (fails, unreviewed) = by_line.get(&line.line).copied().unwrap_or_default();
        (line.open_fails, line.unreviewed) = (Some(fails), Some(unreviewed));
    }
    Some(counts)
}

pub(super) fn warnings(trust: &ProjectTrust, warnings: &mut Vec<String>) {
    if trust.open_fails > 0 || trust.unreviewed > 0 {
        warnings.push(format!("研究分支上有 {} 个未关闭的核对问题、{} 个结论文件还没核过", trust.open_fails, trust.unreviewed));
    }
    if trust.unresolved_citations > 0 {
        warnings.push(format!("研究分支上有 {} 条引用解析不到", trust.unresolved_citations));
    }
    if trust.retracted_citations > 0 {
        warnings.push(format!("研究分支上有 {} 篇被引文献已撤稿", trust.retracted_citations));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quality_blank_shared_cases() {
        let cases: Value = serde_json::from_str(include_str!("../../../plugins/research/docs/blank-cases.json")).unwrap();
        for case in cases.as_array().unwrap() {
            assert_eq!(
                blank(case["kind"].as_str().unwrap(), case["text"].as_str().unwrap()),
                case["blank"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
        }
    }
    #[test]
    fn quality_blank_uses_all_five_bundled_templates_and_literal_rules() {
        for file in ["SUMMARY.md", "OVERVIEW.md", "LEDGER.md", "results/r1.md", "strategy/s1.md"] {
            let original = crate::plugins::research_template(template(file).unwrap()).unwrap();
            assert!(blank(file, &original), "{file}");
            assert!(blank(
                file,
                &(original.clone() + "\n# 标题\n<!-- comment -->\n1. <占位>\n+ <占位>\n| 甲 | 乙 |\n|---|---|\n| <占位> | |\n")
            ));
            assert!(!blank(file, &(original + "\n真实内容\n")));
        }
        assert!(!blank("SUMMARY.md", "旧版模板说明文字\n"));
        assert!(!blank("LEDGER.md", "| 编号 | 数字 |\n|---|---|\n| C1 | 42 |\n"));
        assert!(!needed("research", "research/results/nested/x.md"));
        assert!(!needed("research", "research/audits/plan-x.json"));
        assert!(needed(".", "sources/x.json"));
    }
}
