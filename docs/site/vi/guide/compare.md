---
description: So sánh claude-code-ui với Claude Code CLI, các ứng dụng của chính Anthropic và các giao diện cộng đồng khác cho Claude Code (CloudCLI / claudecodeui, opcode, claude-code-webui), và khi nào nên chọn cái nào.
---

# So sánh với công cụ khác

claude-code-ui là một trong nhiều cách dùng Claude Code ngoài terminal thuần. Trang này nói điểm khác biệt của nó để bạn chọn đúng công cụ. Thông tin về các dự án khác lấy từ trang của chính họ; hãy xem ở đó để biết tình trạng mới nhất.

## Tóm tắt một câu {#in-one-sentence}

claude-code-ui là **một daemon cục bộ cộng với một ứng dụng web**: Claude Code chạy trên máy của bạn, còn bạn theo dõi và điều khiển nhiều phiên từ trình duyệt bất kỳ, kể cả điện thoại, không qua dịch vụ đám mây nào.

## So với Claude Code CLI {#compared-with-the-claude-code-cli}

CLI và claude-code-ui chạy cùng một Claude Code và dùng chung lịch sử trong `~/.claude`, nên bạn chuyển qua lại được theo từng phiên.

| | CLI `claude` | claude-code-ui |
| --- | --- | --- |
| Dùng ở đâu | Mỗi phiên một terminal | Trình duyệt bất kỳ, nhiều phiên trong các tab |
| Từ điện thoại | Cần SSH và ứng dụng terminal | Có sẵn (`--tailscale`), cài như ứng dụng, có thông báo đẩy |
| Phiên sau khi đóng cửa sổ | Kết thúc cùng terminal | Vẫn chạy trong daemon |
| Yêu cầu đang chờ ở nhiều phiên | Xem từng terminal | Một [trang Focus](../features/focus) |
| Tệp, diff, đồ thị git | Công cụ riêng | Các bảng cạnh khung chat |
| Cài đặt | `npm i -g @anthropic-ai/claude-code` | `npx claude-code-ui` (dùng Claude Code đã đăng nhập của bạn) |

## So với ứng dụng của Anthropic {#compared-with-anthropics-own-apps}

Anthropic phát hành Claude Code dưới dạng CLI, extension cho IDE, ứng dụng desktop và Claude Code on the web. Claude Code on the web chạy phiên trên đám mây của Anthropic. claude-code-ui thì chạy mọi phiên trên máy của bạn, với tệp, công cụ và thông tin đăng nhập cục bộ, và chỉ bạn truy cập được. Đây là dự án cộng đồng, không chính thức.

## So với các giao diện cộng đồng khác {#compared-with-other-community-uis}

| Dự án | Là gì | Giấy phép | Gói / lệnh |
| --- | --- | --- | --- |
| **claude-code-ui** (dự án này) | Daemon cục bộ + ứng dụng web; nhiều phiên, điện thoại, worktree, điều phối, môi trường WSL và Docker | MIT | npm `claude-code-ui`, lệnh `claude-ui` |
| [CloudCLI](https://github.com/siteboon/claudecodeui) (còn gọi là "Claude Code UI", repo `claudecodeui`) | Giao diện web và di động cho Claude Code và các CLI lập trình khác (OpenCode, Cursor CLI, Codex) | AGPL-3.0 | xem README của dự án |
| [opcode](https://github.com/winfunc/opcode) (trước đây là Claudia) | Ứng dụng desktop và bộ công cụ cho Claude Code | AGPL-3.0 | ứng dụng desktop |
| [claude-code-webui](https://github.com/sugyan/claude-code-webui) | Giao diện chat trên web cho Claude CLI | MIT | xem README của dự án |

Các tên rất giống nhau. Nếu bạn đọc về "Claude Code UI" ở đâu đó, hãy kiểm tra repository: dự án này là [cuonghuunguyen/claude-code-ui](https://github.com/cuonghuunguyen/claude-code-ui).

## Chọn claude-code-ui khi {#pick-claude-code-ui-when}

- Bạn chạy **nhiều phiên Claude Code cùng lúc** và muốn một chỗ cho biết phiên nào đang cần bạn.
- Bạn muốn **trả lời Claude từ điện thoại** trong khi công việc chạy trên máy tính.
- Mã và thông tin đăng nhập phải **ở lại trên máy của bạn**: không tài khoản, không relay, không telemetry.
- Bạn làm việc trên **Windows với WSL** hoặc trong **container Docker** và muốn một giao diện cho tất cả.
- Bạn muốn **đúng hành vi của Claude Code** (yêu cầu cấp quyền, chế độ, lệnh gạch chéo, skill, `/rewind`) chứ không phải một agent khác.

Sẵn sàng? [Cài đặt và chạy lần đầu](install) chỉ mất một phút. Thêm câu trả lời: [Hỏi đáp](faq).
