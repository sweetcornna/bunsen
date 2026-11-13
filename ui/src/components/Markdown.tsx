import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * images：图片怎么显示。"inline"（默认）照常加载；"link" 不加载，只显示“图片：<替代文字>”和链接，
 * 用在内容来自别处（例如汇合点）的地方，免得一打开页面浏览器就去请求外部地址。
 */
export function Markdown({ text, images = "inline" }: { text: string; images?: "inline" | "link" }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          ...(images === "link"
            ? {
                img: ({ src, alt }) => (
                  <a href={src} target="_blank" rel="noopener noreferrer" title={src}>
                    图片：{alt || src || "（没有说明）"}
                  </a>
                ),
              }
            : {}),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
