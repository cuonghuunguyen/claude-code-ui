# MCP, skill & plugin {#mcp-skills-plugins}

Ba hộp thoại quản lý máy chủ MCP, skill và plugin của Claude Code, giống như tiện ích mở rộng VS Code. Thay đổi được lưu vào các tệp cấu hình riêng của Claude Code, nên CLI `claude` cũng thấy chúng.

## Cách mở {#how-to-open-them}

| Hộp thoại | Nhập trong ô prompt | Hoặc trong [bảng lệnh](palette) |
| --- | --- | --- |
| **Máy chủ MCP** | `/mcp` | Máy chủ MCP |
| **Lệnh gạch chéo** (skill) | `/skills` hoặc `/help` | Lệnh gạch chéo |
| **Quản lý plugin** | `/plugins`, `/plugin` hoặc `/marketplace` | Quản lý plugin |

## Máy chủ MCP {#mcp-servers}

- Xem từng máy chủ và trạng thái của nó. Mở một máy chủ để xem các công cụ của nó.
- Bật hoặc tắt máy chủ, kết nối lại, đăng nhập vào máy chủ, hoặc gỡ nó.
- **Thêm máy chủ MCP:** đặt tên, chọn **Giao thức truyền** (stdio, SSE hoặc HTTP) và **Phạm vi**, rồi bấm **Thêm máy chủ**.
- Nếu máy chủ cần đăng nhập qua trình duyệt, hãy hoàn tất rồi dán **URL gọi lại** vào hộp thoại khi được yêu cầu.

## Lệnh gạch chéo {#slash-commands}

Liệt kê mọi lệnh và skill. Mỗi skill có một **trạng thái**:

| Trạng thái | Claude thấy | Bạn chạy được |
| --- | --- | --- |
| Bật | Tên và mô tả | Có |
| Chỉ tên | Chỉ tên | Có |
| Chỉ người dùng | Không | Có |
| Tắt | Không | Không |

## Plugin {#plugins}

- Tab **Plugin**: các plugin đã cài và có sẵn. Cài đặt, bật hoặc tắt, **Cập nhật plugin**, **Gỡ cài đặt**.
- Tab **Chợ plugin**: thêm hoặc gỡ danh mục plugin, hoặc làm mới một danh mục.

## Phạm vi {#scopes}

Nơi một cài đặt được lưu:

| Phạm vi | Áp dụng cho | Lưu trong |
| --- | --- | --- |
| **Cục bộ** | Dự án này, chỉ bạn | `~/.claude.json` |
| **Người dùng** | Mọi dự án của bạn | Cài đặt người dùng của bạn |
| **Dự án** | Mọi người dùng kho mã | `.mcp.json` / `.claude/settings.json` trong kho mã |
