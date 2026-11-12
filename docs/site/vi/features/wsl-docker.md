# WSL, Docker & SSH

claude-code-ui cũng có thể chạy phiên bên trong các bản phân phối WSL của bạn (trên Windows) bên trong các container Docker đang chạy và trên các máy bạn truy cập qua SSH. Mỗi nơi như vậy là một **môi trường**: có bản cài Claude riêng, `~/.claude` riêng và tệp riêng.

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

## Khi cài đặt thất bại {#when-an-install-fails}

Cài đặt hoặc khởi động thất bại không chôn lý do trong một đống chữ.

- **Trong thanh bên,** dưới các dự án của môi trường đó, một dòng tóm tắt nói điều gì thất bại ("Không khởi động được" khi không có gì thêm). **Chi tiết** mở ra kết quả phía sau, ví dụ kết quả của npm, bạn có thể chọn và sao chép. **Thử lại** chạy lại. **Chi tiết** vẫn mở sau khi **Thử lại**, nên lần thất bại thứ hai hiện kết quả ngay chỗ bạn đang đọc.
- **Trong Mở dự án,** cùng dòng tóm tắt và **Chi tiết** hiện trong bảng của môi trường. Nút chính ghi **Thử cài lại** (**Thử cập nhật lại** sau một lần cập nhật thất bại) và chạy lại việc cài đặt. **Kiểm tra lại** xem lại máy mà không cài, ví dụ sau khi bạn tự cài công cụ còn thiếu. Bảng nêu rõ cần sửa gì trước tiên: Node.js, công cụ build, `tar` và `gzip`, một thư mục ghi được.
- Lỗi của chính bước thiết lập (thiếu công cụ, Node.js quá cũ) không tự thử lại. Hãy sửa rồi bấm **Thử cài lại**. Lỗi khởi động khác khi Claude UI khởi động được tự thử thêm một lần sau 30 giây.

## Quay lại sau khi khởi động lại {#coming-back-after-a-restart}

Môi trường đã chạy một lần sẽ khởi động lại cùng Claude UI, và tự khởi động lại nếu dừng (sau 2 giây, 10 giây và 60 giây; lần dừng thứ tư trong vòng mười phút hiện lỗi kèm **Thử lại**). Container chạy lại sẽ khởi động trong khoảng 30 giây. Sau bản build Claude UI mới, môi trường cập nhật từ bundle đã tải; nếu distro hoặc container của nó cần npm, môi trường vẫn tắt và thanh bên hiện **Cần cập nhật** kèm **Cập nhật**. Khi môi trường đang khởi động, các dự án của nó vẫn nằm trong thanh bên. Trong **Cài đặt › Môi trường**, **Khởi động cùng Claude UI** tắt hành vi này cho một môi trường (các dự án của nó rời khỏi thanh bên) và **Tự động cập nhật** dừng việc cập nhật tự động.

## Máy chủ SSH {#ssh-hosts}

Mỗi mục `Host` trong ssh config của bạn (`~/.ssh/config` và các file nó `Include`) là một môi trường tên `SSH: <alias>`. Cần có `ssh` trên máy của bạn. Máy chủ Linux và macOS dùng được. Máy chủ Windows chưa hỗ trợ.

### Cách mở dự án trên máy chủ SSH {#how-to-open-a-project-on-an-ssh-host}

1. Bấm **Mở dự án**.
2. Trong **Nơi mở dự án**, chọn **SSH host**, rồi chọn một host. Host chưa có trong danh sách: bấm **Thêm SSH host…**, gõ lệnh ssh của nó và xem host đã phân tích trong phần xem trước. **Thêm host** ghi một mục `Host` vào ssh config của bạn. Muốn đổi tên hoặc xóa, sửa file đó.
3. Lần đầu, bấm **Cài đặt**. claude-code-ui tự sao chép vào `~/.local/share/claude-ui/side` trên host qua ssh, từ máy của bạn: host không cần internet. Host mà bundle không phù hợp (musl, CPU khác, macOS, BSD) cài bằng npm và cần Node.js 22+ và npm ở đó. Hộp thoại cho biết thiếu gì.
4. Chọn một thư mục và mở nó.

ssh chạy không hỏi gì (`BatchMode`): không mật khẩu, không hỏi passphrase. Dùng khóa, agent hoặc `ProxyJump` trong ssh config. Nếu host key chưa biết hoặc đăng nhập bị từ chối, chạy `ssh <alias>` một lần trong terminal rồi thử lại. Host giữ đăng nhập Claude riêng của nó.

### Một Hub cho mỗi máy {#one-hub-per-machine}

Một môi trường là Hub của máy đó. Nếu host đã chạy một Claude UI, Claude UI của bạn gắn vào nó và không khởi động cái thứ hai. Việc này không cần cài đặt khi Claude UI đó là bản dựng nói được giao thức tương thích (không cần cùng phiên bản): Claude UI của bạn dùng cầu nối của Hub ở đó và không sao chép gì. Nó chỉ cài bản dựng của chính nó khi không có Claude UI nào chạy ở đó hoặc các giao thức không trùng nhau (xem [Phiên bản](#versions)). Nếu chưa có, Claude UI của bạn khởi động một cái ở đó (chỉ trên `127.0.0.1`) rồi gắn vào. Hub do chính bạn khởi động trên host không bao giờ bị dừng, khởi động lại hay đổi cấu hình. Cài đặt của nó (thư mục gốc được phép, bypass, chế độ mặc định) giới hạn các phiên được gắn vào.

Nhiều Claude UI có thể gắn vào cùng một host, giống nhiều trình duyệt cùng kết nối một Hub.

### Khi kết nối bị đứt {#when-the-connection-drops}

- Kết nối ssh bị đứt không làm dừng lượt chạy, terminal hay prompt trên host. Môi trường hiện **Đang kết nối lại…** và tự gắn lại.
- Sau khi bạn khởi động lại Claude UI, nó gắn lại vào các host đã gắn trước đó. Lượt chạy và terminal vẫn như cũ.
- Hub mà Claude UI của bạn đã khởi động trên host sẽ kết thúc khi không có Claude UI nào gắn vào, không có trình duyệt nào kết nối và không có lượt chạy nào trong thời gian chờ (**Grace period**). Đặt theo từng môi trường trong **Cài đặt › Môi trường** (**Giữ chạy khi không có Claude UI (phút)**, mặc định 30).
- Nếu việc gắn thất bại hẳn, dòng hiện lý do và **Thử lại**, kèm kết quả phía sau **Chi tiết** (xem [Khi cài đặt thất bại](#when-an-install-fails)).

### Phiên bản {#versions}

Khi Claude UI trên host và Claude UI của bạn không dùng chung được, dòng hiện cả hai phiên bản: "Claude UI 1.1.0 ở đó, 1.2.0 ở đây: hai bên không dùng chung được." Nếu bản ở đó cũ hơn, **Cập nhật** (trong bảng Mở dự án và trong Cài đặt › Môi trường) chạy `claude-ui update` ở đó. Claude UI của bạn tự gắn lại sau khi khởi động lại. Nếu bản ở đó mới hơn, hãy cập nhật Claude UI này.

**Khởi động cùng Claude UI** mặc định tắt với máy chủ SSH. Bật trong Cài đặt › Môi trường để kết nối ở mỗi lần khởi động.

## Cần biết {#good-to-know}

- Dự án và phiên của mọi môi trường dùng chung một thanh bên. Huy hiệu cho biết môi trường (ví dụ `WSL`, `Docker` hoặc `SSH: demo-host`).
- Dự án và môi trường có thể có tên và biểu tượng riêng của bạn. Xem [Tên và biểu tượng riêng](/vi/features/projects#custom-names-and-icons).
- Phiên trên một môi trường chạy Claude của môi trường đó, mở terminal của môi trường đó và dùng cấu hình của môi trường đó.
- Đường dẫn gõ vào quyết định môi trường: `C:\...` là Windows, `/home/...` là WSL, `\\wsl.localhost\<distro>\...` là distro đó.
- Các distro WSL riêng của Docker và Rancher Desktop bị bỏ qua.
- Trong container, bạn duyệt được thư mục home và thư mục làm việc của image. Đặt `CLAUDE_UI_ROOTS` trong container để thay đổi.
- Không có Docker, hoặc khi engine của nó đang dừng, không có gì thay đổi. Tab Docker hiện gợi ý.
