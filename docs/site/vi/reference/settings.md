# Cài đặt

Mở **Cài đặt** bằng <kbd>Ctrl</kbd>+<kbd>,</kbd> (<kbd>⌘</kbd> <kbd>,</kbd> trên Mac) hoặc nút **Cài đặt** ở cuối thanh bên. Chọn một nhóm ở bên trái.

![Hộp thoại Cài đặt](/screenshots/settings.png)

Các nhóm nằm dưới bốn đề mục:

| Đề mục | Nhóm |
| --- | --- |
| Ứng dụng | Giao diện, Chung, Bố cục, Thông báo, Bàn phím |
| Phiên | Điều phối, Focus, Giới hạn mức dùng |
| Tích hợp | Git, Jira |
| Hệ thống | Side, Hiệu năng, Trợ giúp và giới thiệu |

Phần lớn cài đặt chỉ **được lưu trong trình duyệt này**. Điều phối, Focus, Giới hạn mức dùng (trừ vòng mức dùng), Git, Jira, Side, Hiệu năng và thông báo màn hình nền được lưu trong daemon và áp dụng cho mọi trình duyệt.

## Giao diện {#appearance}

| Cài đặt | Tùy chọn |
| --- | --- |
| Chủ đề | Default, Catppuccin, Tokyo Night, Solarized, Nord, Dracula, One. Đổi màu cùng lúc cho ứng dụng, trình soạn thảo, diff, terminal và đồ thị git. Dracula không có màu sáng: ở chế độ sáng nó hiện Default. Được lưu trong trình duyệt này. |

Nút chủ đề ở góc trên bên phải vẫn chuyển lần lượt Hệ thống, Sáng và Tối bên trong chủ đề.

## Chung {#general}

### Dòng thời gian {#timeline}

| Cài đặt | Chức năng |
| --- | --- |
| Chỉ tín hiệu | Gộp mỗi chuỗi lệnh gọi công cụ thành một dòng, như "4 lệnh gọi công cụ · Read 3 · Grep 1". Prompt của bạn, văn bản của Claude, lỗi và yêu cầu đang chờ vẫn hiện. Cũng có thể dùng <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>S</kbd>. |

### Gửi {#sending}

| Cài đặt | Chức năng |
| --- | --- |
| Khi Claude đang làm việc, Enter | **Điều hướng lượt** (mặc định; <kbd>Alt</kbd>+<kbd>Enter</kbd> xếp hàng đợi) hoặc **xếp tin nhắn vào hàng đợi** (<kbd>Alt</kbd>+<kbd>Enter</kbd> điều hướng). Tin nhắn trong hàng đợi chờ và bắt đầu lượt riêng khi Claude rảnh. Nút gửi đổi theo lựa chọn này. |

### Màn hình {#screen}

| Cài đặt | Chức năng |
| --- | --- |
| Giữ màn hình sáng | Giữ màn hình bật khi claude-ui đang mở. Xem [Giữ màn hình sáng](../features/keep-awake). |
| Chỉ khi có phiên đang chạy | Chỉ giữ khi có phiên đang chạy hoặc đang chờ bạn. |

## Bố cục {#layout}

### Thanh bên {#sidebar}

| Cài đặt | Chức năng |
| --- | --- |
| Chỉ hiện phiên đang hoạt động | Chỉ liệt kê phiên đang chạy hoặc cần nhập liệu. Tìm kiếm vẫn tìm thấy tất cả. |
| Nhóm theo | **Worktree** nhóm các phiên của một dự án theo worktree. **Dự án** liệt kê chúng ngay dưới dự án, với trạng thái dạng văn bản. |

### Tab {#tabs}

| Cài đặt | Chức năng |
| --- | --- |
| Nhóm tab | Theo dự án, Theo worktree, hoặc Không |
| Tab thu gọn | Hiện mỗi nhóm thành một chip. Mở các tab của nhóm từ chip. Cần có nhóm tab. |
| Tự đóng tab rảnh sau | Tắt, 1 giờ hoặc 1 ngày. Không bao giờ đóng tab đã ghim, đang chạy hoặc chưa đọc, hay tab có bản nháp. Các phiên vẫn chạy. |

### Thay đổi {#changes}

| Cài đặt | Tùy chọn |
| --- | --- |
| Chế độ xem diff mặc định | Thay đổi của phiên, Chưa commit, So với nhánh |

### Terminal {#terminal}

| Cài đặt | Chức năng |
| --- | --- |
| Vị trí terminal | **Dưới** (mặc định), **Bảng bên** hoặc **Vùng chính** (một tab cạnh phiên). Xem [Khung và bố cục](../features/panes). |

## Thông báo {#notifications}

| Cài đặt | Chức năng |
| --- | --- |
| Thông báo trong ứng dụng | Một thẻ trong trang này khi phiên khác cần nhập liệu hoặc hoàn tất. Bật mặc định. |
| Thông báo đẩy | Thông báo từ trình duyệt này, kể cả khi đã đóng trang. Cần HTTPS hoặc localhost. |
| Thông báo màn hình nền trên *máy tính* | Máy tính chạy daemon hiện thông báo hệ thống khi không có trình duyệt nào bật thông báo đẩy. Áp dụng cho mọi trình duyệt. |

Xem [Thông báo](../features/notifications).

## Bàn phím {#keyboard}

Mở hộp thoại [Phím tắt](shortcuts), nơi bạn có thể gán lại mọi phím tắt. **Hiện mẹo phím tắt**: sau lần nhấn thứ 2, 5 và 10 vào một nút, một mẹo hiện phím tắt của nút đó hoặc đề nghị gán phím. Không áp dụng trên màn hình cảm ứng.

## Điều phối {#orchestration}

Cho phép một phiên bắt đầu và điều khiển các phiên worker. Tắt mặc định. **Thông báo từ worker** bật hoặc tắt thông báo cho các phiên worker. Mọi cài đặt được mô tả ở trang [Điều phối](../features/orchestration#settings).

## Focus {#focus}

| Cài đặt | Chức năng |
| --- | --- |
| Tiếp theo cho bạn | Sau mỗi lượt, Claude dự đoán prompt tiếp theo của bạn; các dòng đã xong trên Focus hiện nó dưới dạng chip. Tắt mặc định. Dùng thêm một yêu cầu nhỏ mỗi lượt, tái sử dụng bộ nhớ đệm prompt. Áp dụng cho phiên bắt đầu hoặc tiếp tục sau khi đổi. |

## Giới hạn mức dùng {#usage-limits}

| Cài đặt | Chức năng |
| --- | --- |
| Tự tiếp tục sau khi giới hạn mức dùng được đặt lại | Gửi "continue" tới phiên đã bị giới hạn gói chặn, khi giới hạn được đặt lại. |
| Vòng mức dùng hiển thị | Mức dùng cao nhất, Phiên (5 giờ) hoặc Hằng tuần. Được lưu trong trình duyệt này. |

## Git {#git}

Các cài đặt giống tiện ích mở rộng Git của VS Code, cùng tên và cùng giá trị. Chúng áp dụng cho mọi dự án và quyết định kho mã nào mà bộ chọn kho mã và dấu trong cây tệp tìm thấy.

| Cài đặt | Chức năng |
| --- | --- |
| Auto repository detection | `true` (mặc định), `subFolders`, `openEditors` hoặc `false`. |
| Repository scan max depth | Độ sâu quét tìm kho mã. Mặc định `1`; `-1` = không giới hạn. |
| Repository scan ignored folders | Tên thư mục bị bỏ qua khi quét. Mặc định `node_modules`. |
| Scan repositories | Các đường dẫn bổ sung để tìm, tính từ thư mục dự án. |
| Ignored repositories | Các kho mã cần loại trừ. |
| Detect submodules / Detect submodules limit | Tìm submodule, tối đa số này (mặc định `10`). |
| Ignore submodules | Bỏ qua thay đổi của submodule trong cây tệp. |
| Open repository in parent folders | `always` (mặc định), `never` hoặc `prompt` (ở đây hoạt động như `always`). |

## Jira {#jira}

Một kết nối Jira cho tab **Ticket** của [Tạo worktree](../features/projects#create-a-worktree).

| Cài đặt | Chức năng |
| --- | --- |
| Jira URL | Cloud: `https://<site>.atlassian.net`. Data Center hoặc Server: địa chỉ https của Jira của bạn (http chỉ cho `localhost` và `127.0.0.1`). Đổi host sẽ xóa token đã lưu. |
| Email | Email tài khoản Atlassian của bạn. Chỉ cho Jira Cloud. |
| API token / Personal access token | Cloud: API token từ id.atlassian.com › Security › API tokens. Data Center hoặc Server: personal access token từ hồ sơ Jira của bạn. Chỉ lưu trên máy tính của daemon (`secrets.json`), không hiện lại: khi đó dòng này ghi **Đã đặt token**, kèm **Thay thế** và **Xóa**. |
| Branch template | Cách một ticket đặt tên nhánh. Mặc định `{type}/{key}-{summary}`: `{type}` là `bugfix` cho Bug, `feature` cho Story, Task hoặc New Feature, còn lại để trống; `{key}` là mã ticket; `{summary}` là tiêu đề, đã rút gọn. |
| Ticket filter (JQL) | Các ticket mà tab Ticket liệt kê, ví dụ `project = ABC AND statusCategory != Done`. Văn bản nhập vào tìm bên trong bộ lọc; mã ticket hoặc URL ticket bỏ qua bộ lọc. Để trống: các ticket đang mở của bạn. |
| Kiểm tra kết nối | Hiện "Đã kết nối với *tên của bạn*" hoặc lỗi. |

## Side {#sides}

Hiện khi có một bản phân phối WSL hoặc container trong danh sách. Với mỗi side:

| Cài đặt | Chức năng |
| --- | --- |
| Khởi động cùng Claude UI | Khởi động side cùng Claude UI, từ lần khởi động sau. Tắt cũng gỡ các dự án của side khỏi thanh bên. |
| Tự động cập nhật | Cài bản dựng Claude UI mới từ bundle. Cần bật Khởi động cùng Claude UI. |

Xem [WSL và Docker](../features/wsl-docker).

## Hiệu năng {#performance}

| Cài đặt | Chức năng |
| --- | --- |
| Theo dõi hiệu năng | Đo độ phản hồi trên máy tính của daemon. Chỉ có thời lượng và số đếm; không có gì rời khỏi máy tính. Bên dưới: kết quả, **Xóa** và **Xuất JSON**. |

## Trợ giúp và giới thiệu {#help-about}

### Hướng dẫn {#guide}

**Chuyến tham quan có hướng dẫn:** chạy lại chuyến tham quan ngắn về dự án, tab, tệp, thay đổi, đồ thị git và terminal.

### Giới thiệu {#about}

Phiên bản của ứng dụng web và của daemon. Hãy ghi cả hai trong báo cáo lỗi.

## Không nằm trong Cài đặt {#not-in-settings}

- **Chế độ:** nút chủ đề ở góc trên bên phải chuyển lần lượt Hệ thống → Sáng → Tối, bên trong chủ đề màu bạn chọn ở Cài đặt › Giao diện.
- **Model, chế độ, effort:** theo từng phiên, trong [hộp prompt](../features/prompt-box).
- **Tùy chọn máy chủ** (cổng, thư mục gốc, truy cập từ xa): [cờ CLI](cli).
