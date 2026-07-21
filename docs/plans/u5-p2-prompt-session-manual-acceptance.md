# U5 P2 prompt/session 最小人工验收

目标只验证三件事：当前会话的 Skill 清单不在刷新中途改变；新会话读取最新策略；被禁 Skill 的正文和 linked file 都不能读取。

## 前置条件

- 使用真实 Enterprise Gateway 和构建后的 Desktop。
- `expense-review` 必须从 Desktop 的“企业发现”页安装成功，不得手工复制到用户 Skill 目录。
- 管理后台初始状态为 `expense-review = available`。
- 不在截图或记录中保留 token、Cookie、用户名、绝对用户目录或 Skill 正文。

## A. 当前会话不变，但读取立即受限

1. 新建会话 S1，发送：`只根据当前会话提供的 Skill 清单，回答是否包含 expense-review；不要猜测。`
2. 确认 S1 回答包含该 Skill。
3. 在管理后台把 `expense-review` 改为 `blocked`，然后在 Desktop 执行策略刷新。
4. 仍在 S1 重复第 1 步。预期：S1 的既有 Skill 清单保持不变。
5. 仍在 S1 明确要求读取 `expense-review` 的 `references/checklist.md`。预期：返回 `enterprise_skill_policy_denied`，且不出现 linked file 正文。

通过条件：S1 的会话清单没有被中途改写，同时 blocked Skill 已无法读取。

## B. 新会话读取最新策略

1. 保持后台 `expense-review = blocked`，新建会话 S2。
2. 发送与 A-1 相同的问题。

通过条件：S2 的 Skill 清单不包含 `expense-review`。

## C. 恢复只对再下一个新会话生效

1. 在管理后台把 `expense-review` 恢复为 `available`，在 Desktop 执行策略刷新。
2. 在原 S2 再次询问当前 Skill 清单。预期：仍不包含 `expense-review`。
3. 新建会话 S3，再次询问并读取 `references/checklist.md`。

通过条件：S2 仍保持原清单；只有 S3 重新包含并可读取 `expense-review`。

## 现有代码回归锚点

- `test_existing_session_prompt_bytes_do_not_change_after_policy_refresh`：旧会话缓存的 system prompt UTF-8 字节在策略刷新后保持不变。
- `test_prompt_snapshot_keeps_denied_skill_metadata_for_policy_only_allow`：blocked 时新 prompt 不包含目标 Skill，恢复 available 后新 prompt 才重新包含。
- `test_skill_view_denies_main_and_linked_reads_before_runtime_setup`：主文件和 linked file 在读取正文前返回策略拒绝，正文 sentinel 不泄漏。

本轮不重复新增同义测试；若人工验收暴露代码与上述合同不一致，再针对真实缺口补回归测试。
