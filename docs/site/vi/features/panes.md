# Khung & bố cục

Thay đổi, Tệp, Git graph, Terminal, Kế hoạch và Artifacts là các **khung**. Mỗi khung là một tab của bảng bên, của bảng dưới hoặc (trừ Thay đổi) của vùng chính, và bạn chọn nơi đặt nó.

![Không gian làm việc với terminal gắn ở phía dưới](/screenshots/panes.png)

## Cách dùng {#how-to-use}

1. Bấm chuột phải vào tab khung (<kbd>Shift</kbd>+<kbd>F10</kbd> trên bàn phím, nhấn giữ trên màn hình cảm ứng) và chọn **Chuyển xuống bảng dưới** hoặc **Chuyển sang bảng bên**.
2. Hoặc mở menu **⋯** của bảng (**Thao tác bảng bên** hoặc **Thao tác bảng dưới**) và chọn **Chuyển … xuống bảng dưới** hoặc **Chuyển … sang bảng bên**.
3. Hoặc kéo tab khung thả lên tab khác hoặc lên một bảng. Một dải nét đứt **Bảng bên** hoặc **Bảng dưới** cho biết vị trí của bảng trống. <kbd>Esc</kbd> hủy thao tác kéo.
4. Để gắn bảng bên sang phía còn lại, dùng **Chuyển bảng bên sang trái** (hoặc **phải**) trong menu **⋯** của nó.
5. Để hoàn tác tất cả, chọn **Đặt lại bố cục** trong menu tab khung, menu **⋯** của bảng hoặc [bảng lệnh](/vi/features/palette).

## Vùng chính {#the-main-area}

Kế hoạch, Tệp, Git graph và Terminal cũng có thể là tab nằm cạnh các phiên của bạn. Bấm chuột phải vào tab khung và chọn **Chuyển vào vùng chính**, hoặc kéo tab thả lên thanh tab hoặc vùng phiên. Khi đó khung mở thành một tab trong nhóm của dự án trên thanh tab ("Kế hoạch · *phiên*", "Terminal · *dự án*"), và luôn hiển thị dự án hoặc phiên đó trong khi bạn làm việc ở phiên khác. **Chuyển sang bảng bên** hoặc **Chuyển xuống bảng dưới** đưa nó về, và tab đóng lại (một thông báo nhanh có **Hoàn tác**). Menu của chính tab có các mục tương tự. Git graph luôn chiếm toàn bộ vùng.

Kéo tab khung thả lên bảng bên hoặc bảng dưới để chuyển nó đến đó.

## Các khung {#the-panes}

| Khung | Hiển thị |
| --- | --- |
| [Thay đổi](/vi/features/changes), [Tệp](/vi/features/files), [Git graph](/vi/features/git-graph), [Terminal](/vi/features/terminal) | Xem trang riêng của từng khung. |
| **Kế hoạch** | Kế hoạch mới nhất của phiên, với cùng nội dung như thẻ kế hoạch. Chỉ được liệt kê khi phiên có kế hoạch. Khi kế hoạch đang chờ bạn trả lời, khung ghi rõ điều đó, kèm **Đi đến yêu cầu**. **Mở trong tab** trên thẻ kế hoạch hoặc trên màn hình duyệt kế hoạch sẽ hiện khung ở bất kỳ nơi nào nó đang đặt. |
| **Artifacts** | Các artifact mà phiên đã xuất bản (công cụ Artifact của Claude). Chọn một artifact để xem trước, hoặc bấm **Mở trong tab**. Chỉ được liệt kê khi phiên đã xuất bản artifact. |

## Một tệp hoặc một artifact dưới dạng tab {#one-file-or-one-artifact-as-a-tab}

- **Mở trong tab** trên một tệp (một dòng trong cây, một tab trình soạn thảo của Tệp, hộp thoại tệp, hoặc <kbd>Alt</kbd>+<kbd>Enter</kbd> trong **Mở tệp**) chuyển tệp đó thành tab riêng cạnh phiên của nó. Đó vẫn là cùng một trình soạn thảo. **Chuyển về Tệp** đưa nó trở lại. Một tệp chỉ mở ở một nơi.
- **Mở trong tab** trên thẻ Artifact đã xuất bản hiển thị trang trong tab riêng với chiều cao đầy đủ. **Chuyển về Artifacts** đưa nó trở lại. Bản xem trước trong thẻ vẫn còn.
- Đặt một trong hai bên cạnh phiên bằng **Chia sang phải** hoặc **Chia xuống dưới** (xem [Chia màn hình](/vi/features/split-view)).

## Một phiên trong bảng bên hoặc bảng dưới {#a-session-in-the-side-or-bottom-panel}

Bấm chuột phải vào tab phiên và chọn **Chuyển sang bảng bên** hoặc **Chuyển xuống bảng dưới** (màn hình rộng). Phiên đó, cùng dòng thời gian, hộp prompt và các yêu cầu của nó, vẫn ở đó trong khi bạn làm việc ở các phiên khác, ví dụ để theo dõi một worker. Nó có các tính năng như một tab: liên kết tệp, **Trích dẫn**, **Mở trong tab**, tệp đính kèm ảnh. **Chuyển vào vùng chính** trong menu của tab gắn bảng sẽ đưa nó về. Mở phiên từ thanh bên, [Focus](/vi/features/focus) hoặc một thông báo sẽ chọn tab gắn bảng của nó. Trên cửa sổ hẹp hơn 1024px, nó lại là tab bình thường.

## Terminal {#the-terminal}

[Terminal](/vi/features/terminal) mặc định nằm ở bảng dưới, bên dưới phiên và bảng bên. Bảng dưới đổi kích thước được (kéo tay nắm phía trên), phóng to được (**Phóng to bảng** / **Khôi phục bảng**) và ẩn được (**Ẩn bảng dưới**). Nhấn <kbd>Ctrl</kbd>+<kbd>`</kbd> hoặc dùng nút terminal trên thanh tiêu đề để hiện hoặc ẩn nó.

Để giữ terminal ở bảng bên hoặc vùng chính, đặt **Vị trí terminal** trong [Cài đặt › Bố cục › Terminal](/vi/reference/settings#terminal), hoặc chuyển tab của nó.

## Cần biết {#good-to-know}

- Khung đã chuyển giữ nguyên trạng thái: tệp đang mở, terminal đang chạy, đồ thị đã tải. Tab của nó giữ tiêu điểm bàn phím. Terminal không bao giờ nhận bàn phím cho đến khi bạn bấm vào nó.
- Bảng không có khung nào sẽ bị ẩn. Git graph, Kế hoạch và Artifacts chỉ hiện khi có nội dung để hiển thị. Git graph cần thư mục git.
- Bố cục được lưu theo từng trình duyệt. Bảng bên và bảng dưới mở lại ở tab bạn chọn lần trước, kể cả sau khi tải lại trang.
- **Đặt lại bố cục** khôi phục bố cục mặc định và quên các tab đã ghi nhớ. Nó không đổi kích thước.
- Trên điện thoại không có gắn bảng: bộ chuyển khung mở ở khung bạn dùng lần trước.
