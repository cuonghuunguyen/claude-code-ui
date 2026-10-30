# WSL & Docker

claude-code-ui cũng có thể chạy phiên bên trong các bản phân phối WSL của bạn (trên Windows) và bên trong các container Docker đang chạy. Mỗi nơi như vậy là một **môi trường**: có bản cài Claude riêng, `~/.claude` riêng và tệp riêng.

::: warning Lỗi đã biết ở bản 0.5.0
Môi trường WSL và Docker dừng sau khoảng 15 giây kể từ khi khởi động, với thông báo "stopped (exit code 1)". Đây là lỗi, được theo dõi tại [#263](https://github.com/cuonghuunguyen/claude-code-ui/issues/263).
:::

## Cách mở dự án trong WSL hoặc Docker {#how-to-open-a-project-in-wsl-or-docker}

1. Khởi động claude-code-ui trên máy chủ (trên Windows: chạy trong Windows, không chạy bên trong WSL).
2. Bấm **Mở dự án**.
3. Trong **Nơi mở dự án**, chọn **WSL** (rồi chọn một distro) hoặc **Docker** (rồi chọn một container đang chạy).
4. Lần đầu, bấm **Cài đặt**. claude-code-ui tự sao chép vào môi trường (`~/.local/share/claude-ui/side`) và khởi động tại đó. Trong container Docker, nó mang theo Claude Code, và chỉ mang theo Node.js riêng khi container chưa có bản nào trong phạm vi yêu cầu (xem bên dưới).
5. Chọn một thư mục và mở nó.

Sau đó, **Kiểm tra lại** hiện trạng thái của môi trường, còn **Cập nhật** hoặc **Cài lại** làm mới môi trường.

## Môi trường cần gì {#what-the-side-needs}

Hầu hết container Docker (Linux x86_64 hoặc arm64 với glibc 2.28+, ví dụ image Debian, Ubuntu hoặc Fedora) dùng một **bundle**: máy của bạn tải phần hỗ trợ terminal (node-pty) và Claude Code một lần (và Node.js chỉ khi container hoặc distro chưa có Node.js 22 trở lên; bản đã có thì được dùng nguyên trạng, kể cả bản từ nvm), kiểm tra từng phần theo checksum đã công bố, lưu trong `~/.cache/claude-ui/side`, rồi sao chép một tệp vào container. Các container khác (Alpine và image musl khác, CPU khác) cài bằng npm bên trong container.

Distro WSL có cùng yêu cầu (glibc 2.28+, x86_64 hoặc arm64) dùng cùng các phần đã kiểm tra. Không có gì được sao chép: distro đọc chúng từ bộ nhớ đệm trên Windows. Lần cài đầu mất khoảng 10 đến 15 giây. Bản build claude-code-ui mới với cùng các phần chỉ mất khoảng một giây, vì distro dùng lại tệp của lần cài trước. Các distro khác (musl) cài bằng npm trong distro. Nếu distro không phản hồi ở lần kiểm tra đầu, hộp thoại sẽ báo và claude-code-ui cài bằng npm.

Distro WSL theo đường bundle cần `bash`, `tar` và `gzip` (không chỉ `sh`), và không cần Node.js cho chính claude-code-ui. Hook và máy chủ MCP của dự án gọi `node` hoặc `npx` vẫn cần Node.js trong distro.

| | Distro WSL (bundle) | Distro WSL (npm) | Container Docker (bundle) | Container Docker (npm, ví dụ Alpine) |
| --- | --- | --- | --- | --- |
| `sh`, `tar`, `gzip` | Có | | Có | |
| Node.js 22+ | Dùng nếu có, không bắt buộc | Có | Dùng nếu có, không bắt buộc | Có |
| Đăng nhập Claude | `claude login` trong distro | Như vậy | Sao chép `~/.claude/.credentials.json` vào, chạy `claude login` trong container, hoặc đặt `CLAUDE_CODE_OAUTH_TOKEN` | Như vậy |
| Công cụ build cho terminal | Không | `build-essential python3` | Không | make, python3, g++ (Alpine: `apk add make python3 g++`) |
| Truy cập mạng tới npm | Không | Có | Không (`--network none` vẫn chạy được) | Có |
| `/tmp`, `/dev/shm` hoặc thư mục home có thể ghi | | | Có | Có |
| `git` (bảng Git) | Tùy chọn | Tùy chọn | Tùy chọn | Tùy chọn |

Trong Mở dự án, **Container này cần gì** liệt kê các mục trên cho container bạn đã chọn, với ✓ hoặc ✗ cho từng mục sau khi kiểm tra. Nếu thiếu gì đó, hộp thoại cho biết cần chạy lệnh nào. Khi container cài bằng npm, hộp thoại nêu lý do. Đăng nhập Claude không được kiểm tra: hãy đăng nhập như bảng nêu, và phiên khởi động mà chưa đăng nhập sẽ báo điều đó.

Bundle cần máy của bạn truy cập nodejs.org và npm registry một lần cho mỗi phiên bản claude-code-ui (`CLAUDE_UI_UPDATE_REGISTRY` đặt registry mirror). Nếu không truy cập được và cũng không có bản trong bộ nhớ đệm, container cài bằng npm.

## Quay lại sau khi khởi động lại {#coming-back-after-a-restart}

Môi trường đã chạy một lần sẽ khởi động lại cùng Claude UI, và tự khởi động lại nếu dừng (sau 2 giây, 10 giây và 60 giây; lần dừng thứ tư trong vòng mười phút hiện lỗi kèm **Thử lại**). Container chạy lại sẽ khởi động trong khoảng 30 giây. Sau bản build Claude UI mới, môi trường cập nhật từ bundle đã tải; nếu distro hoặc container của nó cần npm, môi trường vẫn tắt và thanh bên hiện **Cần cập nhật** kèm **Cập nhật**. Khi môi trường đang khởi động, các dự án của nó vẫn nằm trong thanh bên. Trong **Cài đặt › Môi trường**, **Khởi động cùng Claude UI** tắt hành vi này cho một môi trường (các dự án của nó rời khỏi thanh bên) và **Tự động cập nhật** dừng việc cập nhật tự động.

## Cần biết {#good-to-know}

- Dự án và phiên của mọi môi trường dùng chung một thanh bên. Huy hiệu cho biết môi trường (ví dụ `WSL` hoặc `Docker`).
- Phiên trên một môi trường chạy Claude của môi trường đó, mở terminal của môi trường đó và dùng cấu hình của môi trường đó.
- Đường dẫn gõ vào quyết định môi trường: `C:\...` là Windows, `/home/...` là WSL, `\\wsl.localhost\<distro>\...` là distro đó.
- Các distro WSL riêng của Docker và Rancher Desktop bị bỏ qua.
- Trong container, bạn duyệt được thư mục home và thư mục làm việc của image. Đặt `CLAUDE_UI_ROOTS` trong container để thay đổi.
- Không có Docker, hoặc khi engine của nó đang dừng, không có gì thay đổi. Tab Docker hiện gợi ý.
