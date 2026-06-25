import type { ReactNode } from "react";
import { Modal, Typography } from "antd";

const { Title, Paragraph, Text } = Typography;

interface ProjectIntroModalProps {
  open: boolean;
  onClose: () => void;
}

const isMac = typeof navigator !== "undefined" && navigator.platform.includes("Mac");
const modKey = isMac ? "⌘" : "Ctrl";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <Title level={5} style={{ marginTop: 0, marginBottom: 8 }}>
        {title}
      </Title>
      {children}
    </div>
  );
}

/**
 * 项目功能介绍弹窗（内容与 README 功能特性对齐的精简版）
 */
export function ProjectIntroModal({ open, onClose }: ProjectIntroModalProps) {
  return (
    <Modal
      title="功能介绍"
      open={open}
      onCancel={onClose}
      footer={null}
      width={560}
      centered
      styles={{ body: { maxHeight: "70vh", overflow: "auto", paddingTop: 8 } }}
    >
      <Paragraph type="secondary" style={{ marginBottom: 16 }}>
        DB Connect 是基于 Tauri 与 React 的跨平台数据库桌面客户端，支持 MySQL 与 PostgreSQL，在本地连接并管理您的数据库。
      </Paragraph>

      <Section title="连接管理">
        <ul style={{ paddingLeft: 20, margin: 0, color: "var(--text-secondary)" }}>
          <li>
            <Text>保存与排序 MySQL / PostgreSQL 连接、连接测试、直连或 SSH 隧道</Text>
          </li>
          <li>
            <Text>SSL/TLS、多种认证方式、空闲超时自动断开</Text>
          </li>
          <li>
            <Text>只读连接与会话 SQL、字符集等高级选项</Text>
          </li>
        </ul>
      </Section>

      <Section title="数据库与对象">
        <ul style={{ paddingLeft: 20, margin: 0, color: "var(--text-secondary)" }}>
          <li>
            <Text>树形浏览数据库与表，虚拟滚动、排序、按名称或注释搜索表</Text>
          </li>
          <li>
            <Text>收藏常用 MySQL 表；数据库 / schema / 表的创建、编辑、删除与重命名</Text>
          </li>
          <li>
            <Text>索引、触发器、外键、函数/过程等对象的可视化管理</Text>
          </li>
        </ul>
      </Section>

      <Section title="表结构与数据">
        <ul style={{ paddingLeft: 20, margin: 0, color: "var(--text-secondary)" }}>
          <li>
            <Text>查看与修改列；MySQL 表引擎管理；分页、排序、Where 条件筛选</Text>
          </li>
          <li>
            <Text>表格内新增、编辑、批量删除；复制为 INSERT；导出 Excel</Text>
          </li>
        </ul>
      </Section>

      <Section title="SQL 编辑器">
        <ul style={{ paddingLeft: 20, margin: 0, color: "var(--text-secondary)" }}>
          <li>
            <Text>Monaco 语法高亮、库/表/列自动补全</Text>
          </li>
          <li>
            <Text>多语句执行、选中执行、EXPLAIN / EXPLAIN ANALYZE</Text>
          </li>
          <li>
            <Text>对 TRUNCATE、DROP DATABASE 等高危语句执行前二次确认</Text>
          </li>
        </ul>
      </Section>

      <Section title="界面与交互">
        <ul style={{ paddingLeft: 20, margin: 0, color: "var(--text-secondary)" }}>
          <li>
            <Text>深色 / 浅色主题切换</Text>
          </li>
          <li>
            <Text>全局快捷键（如新建连接、刷新、断开、搜索表等），可按 </Text>
            <span className="shortcut-key">{modKey}</span>
            <Text> + </Text>
            <span className="shortcut-key">/</span>
            <Text> 打开快捷键说明</Text>
          </li>
        </ul>
      </Section>
    </Modal>
  );
}
