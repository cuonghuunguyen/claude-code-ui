---
description: Trả lời ngắn về claude-code-ui, giao diện web mã nguồn mở cho Claude Code. Nó là gì, cần gì, dùng trên điện thoại, chạy song song nhiều phiên, chi phí, quyền riêng tư và khác gì các dự án tên giống.
faq: true
---

# Hỏi đáp

Trả lời ngắn cho những câu hỏi hay gặp nhất về claude-code-ui. Với thông báo lỗi, xem [Xử lý sự cố](../reference/troubleshooting).

## Về claude-code-ui {#about-it}

### Có giao diện web hay GUI nào cho Claude Code không? {#is-there-a-web-ui-or-gui-for-claude-code}

Có. claude-code-ui là giao diện web miễn phí, mã nguồn mở (MIT) cho Claude Code. Chạy `npx claude-code-ui`, mở đường link nó in ra, và bạn dùng Claude Code ngay trong trình duyệt: phiên trong các tab, yêu cầu cấp quyền thành nút bấm, cây tệp, diff, đồ thị git và terminal cạnh khung chat. Mọi thứ chạy trên máy của bạn. Đây là dự án không chính thức, không liên kết với Anthropic.

### claude-code-ui chính xác là gì? {#what-exactly-is-claude-code-ui}

Một máy chủ cục bộ nhỏ (daemon) cộng với một ứng dụng web. Daemon chạy các phiên Claude Code bằng Claude Agent SDK trên máy tính của bạn. Ứng dụng web, mở trong trình duyệt bất kỳ, hiển thị và điều khiển các phiên đó. Gói npm là `claude-code-ui` và lệnh là `claude-ui`.

### Đây có phải CloudCLI ("Claude Code UI") hay claudecodeui không? {#is-it-the-same-project-as-cloudcli-claude-code-ui-or-claudecodeui}

Không. Đó là các dự án khác, chỉ có tên giống. Dự án này là [cuonghuunguyen/claude-code-ui](https://github.com/cuonghuunguyen/claude-code-ui), phát hành trên npm với tên `claude-code-ui`, lệnh là `claude-ui`. Xem [So sánh với công cụ khác](compare).

### Có miễn phí không? {#is-it-free}

Có. claude-code-ui dùng giấy phép MIT và không có gói trả phí. Claude được dùng qua gói đăng ký Claude của chính bạn, giống như CLI `claude`.

## Cài đặt {#setup}

### Cần gì để chạy? {#what-do-i-need-to-run-it}

Node.js 22 trở lên và Claude Code đã đăng nhập (`claude login`). Trên Linux và WSL cần thêm bộ công cụ C++ cho bảng terminal (`sudo apt install build-essential python3`). Sau đó chạy `npx claude-code-ui`. Xem [Cài đặt và chạy lần đầu](install).

### Có cần khóa API của Anthropic không? {#does-it-need-an-anthropic-api-key}

Không. Nó dùng gói đăng ký Claude mà bạn đã đăng nhập bằng `claude login`, không dùng khóa API.

### Hỗ trợ hệ điều hành nào? {#which-operating-systems-does-it-support}

Windows, macOS và Linux. Trên Windows, một bản cài còn chạy được phiên bên trong các bản phân phối WSL, và trên mọi hệ điều hành thì chạy được bên trong container Docker đang chạy và trên các máy bạn truy cập qua SSH. Xem [WSL, Docker & SSH](../features/wsl-docker).

### Có dùng chung được với phiên mở từ CLI `claude` hay VS Code không? {#does-it-work-with-sessions-i-started-in-the-claude-cli-or-vs-code}

Có. Cả hai đọc và ghi cùng lịch sử trong `~/.claude`. Phiên mở trong CLI hay extension VS Code sẽ hiện trong claude-code-ui, và ngược lại.

## Sử dụng {#using-it}

### Có dùng Claude Code từ điện thoại được không? {#can-i-use-claude-code-from-my-phone}

Được. Khởi động daemon bằng `claude-ui --tailscale` rồi quét mã QR nó in ra bằng điện thoại. Bạn có một link HTTPS mà chỉ thiết bị của bạn mở được, ứng dụng cài được lên màn hình chính, và thông báo đẩy báo khi một phiên cần bạn. Xem [Điện thoại và truy cập từ xa](../features/remote-access).

### Có chạy song song nhiều phiên Claude Code được không? {#can-i-run-many-claude-code-sessions-in-parallel}

Được. Mỗi phiên là một tab, nhóm theo dự án, và tất cả cùng chạy trong daemon. Cho mỗi phiên một git worktree riêng để chúng không đụng vào cùng một bản checkout. [Trang Focus](../features/focus) liệt kê mọi phiên đang chờ bạn trả lời, trên tất cả dự án. Xem [Dự án và worktree](../features/projects).

### Phiên có tiếp tục chạy khi tôi đóng trình duyệt không? {#do-sessions-keep-running-when-i-close-the-browser}

Có. Phiên chạy trong daemon, không chạy trong trang web. Đóng tab, mở lại sau và xem tiếp. Dừng daemon thì lượt đang chạy dừng; phiên và lịch sử vẫn còn.

### Một phiên Claude Code có khởi động và điều khiển phiên khác được không? {#can-one-claude-code-session-start-and-steer-others}

Được, khi bật điều phối. Một phiên điều phối khởi động các phiên worker, mỗi worker trong worktree riêng nếu bạn yêu cầu, và câu hỏi cùng yêu cầu cấp quyền của chúng được chuyển tới bạn. Xem [Điều phối](../features/orchestration).

### Có hỗ trợ yêu cầu cấp quyền, lệnh gạch chéo, skill và MCP server không? {#does-it-support-permission-prompts-slash-commands-skills-and-mcp-servers}

Có. Nó hoạt động như Claude Code: cùng yêu cầu cấp quyền và chế độ, model, lệnh gạch chéo, skill, plugin, MCP server và `/rewind`. Xem [Quyền và chế độ](../features/permissions) và [MCP, skill và plugin](../features/config-dialogs).

## Quyền riêng tư và bảo mật {#privacy-and-security}

### Mã của tôi có đi qua máy chủ bên thứ ba không? {#does-my-code-go-through-a-third-party-server}

Không. claude-code-ui không có máy chủ, tài khoản hay telemetry. Prompt của bạn gửi tới Anthropic, giống như với CLI `claude`. Lời gọi duy nhất khác là kiểm tra phiên bản trên npm, tắt được bằng `--no-update-check`. Xem [Quyền riêng tư](../reference/privacy).

### Mở nó ra mạng có an toàn không? {#is-it-safe-to-expose-it-on-the-network}

Hãy coi quyền truy cập daemon như quyền truy cập shell vào máy của bạn. Mặc định nó chỉ nghe trên `127.0.0.1`, mỗi trình duyệt cần token ghép nối, phiên chỉ dùng được thư mục trong `--roots`, và yêu cầu cấp quyền luôn bật. Muốn dùng trên điện thoại thì dùng `--tailscale`, đừng mở cổng ra internet.
