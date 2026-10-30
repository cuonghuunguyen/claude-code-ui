# Dự án & worktree

**Dự án** là một thư mục bạn làm việc trong đó. Phiên mới bắt đầu trong một dự án.

![Hộp thoại Mở dự án với các dự án gần đây](/screenshots/open-project.png)

## Cách mở dự án {#how-to-open-a-project}

1. Bấm **Mở dự án** (biểu tượng thư mục cạnh **Dự án** trong thanh bên).
2. Chọn một dự án gần đây, duyệt đến một thư mục, hoặc gõ đường dẫn.
3. Dự án hiện trong thanh bên. Bắt đầu một phiên trong đó.

## Cách gỡ dự án {#how-to-remove-a-project}

- Mở menu của dự án trong thanh bên và chọn **Gỡ khỏi danh sách (giữ tệp)**.
- Thao tác này chỉ ẩn dự án. Tệp và lịch sử phiên vẫn còn.

## Worktree {#worktrees}

**Worktree** là một bản checkout git bổ sung của cùng kho mã, trên nhánh riêng. Dùng nó để Claude làm việc trên một nhánh mà không động đến bản checkout chính của bạn.

### Tạo worktree {#create-a-worktree}

1. Rê chuột lên dòng dự án và bấm nút thêm nhánh **Tạo worktree** (hoặc chạy "Worktree mới…" trong [bảng lệnh](/vi/features/palette), hoặc chọn **Tạo worktree…** trong menu dự án).
2. Chọn nguồn của nhánh:
   - **Ticket**: chọn một ticket Jira (ticket đang mở của bạn hiện trước; gõ một key, từ trong phần tóm tắt, hoặc dán liên kết ticket hoặc liên kết pull request có nhánh mang tên ticket). Tên nhánh lấy từ ticket, ví dụ `bugfix/PRJ-123-login-fails`; bạn có thể sửa. Nếu nhánh có key đó đã tồn tại, hãy **Checkout** nó thay vì tạo mới. Thiết lập Jira trong [Cài đặt › Jira](/vi/reference/settings#jira).
   - **Nhánh**: checkout một nhánh local hoặc remote có sẵn. Nhánh chỉ có ở remote sẽ được tạo nhánh local cùng tên theo dõi nó. Không chọn được nhánh đang được checkout trong worktree khác. Dán liên kết pull request (GitHub, GitLab, Bitbucket Server) để liệt kê nhánh mà nó được mở từ đó, hoặc liên kết hay key ticket để liệt kê các nhánh đặt tên theo ticket.
   - **Tên**: gõ tên bất kỳ. `Fix Login Ü` thành nhánh `fix-login-u`; `feat/x` giữ nguyên `feat/x`.
3. Với nhánh mới, **Nhánh gốc** chọn điểm bắt đầu (mặc định: nhánh mặc định của remote, ví dụ `origin/main`).
4. Hộp thoại hiện nhánh và thư mục của nó (`.claude/worktrees/<branch with / replaced by ->`). Bấm **Tạo**. Một tab phiên mới mở trong worktree.

Worktree mới cũng nhận các tệp bị gitignore mà tệp `.worktreeinclude` ở gốc bản checkout chính liệt kê (cú pháp `.gitignore`), ví dụ `.env`. Một tệp chỉ được sao chép khi có mẫu khớp và git bỏ qua nó. Việc sao chép dừng ở 2 GiB hoặc 50.000 tệp mỗi worktree, kèm cảnh báo trong nhật ký daemon. Liên kết không bao giờ được sao chép.

Tóm tắt ticket dài sẽ được rút ngắn, nên tên được tạo luôn hợp lệ. Lỗi chỉ hiện với tên do bạn gõ hoặc sửa. Tên thư mục dài tối đa 64 ký tự, kể cả khi bạn checkout nhánh có sẵn bằng tab **Nhánh**.

**Shift+click** vào nút, hoặc chọn **Worktree mới** trong menu dự án, để tạo ngay một worktree với tên tự tạo.

Chip **Chạy phiên trong** của phiên mới gọi bản checkout chính là **Worktree chính**.

Để xóa nhiều worktree cùng lúc, xem [Dọn dẹp](/vi/features/clean-up). Để xóa một worktree, bấm biểu tượng thùng rác của nó (trên điện thoại: menu của nó › **Xóa worktree…**). Hộp thoại mở ngay với **Đang kiểm tra…**. Sau khi bạn xác nhận, dòng hiện **Đang gỡ…** trong khi việc gỡ chạy nền.

Menu của dòng dự án và của dòng worktree có **Sao chép đường dẫn**.

## Nút ở đầu mục Dự án {#projects-header-buttons}

| Nút | Tác dụng |
| --- | --- |
| Mở dự án | Thêm một dự án. |
| Chọn phiên đang dùng || Cuộn thanh bên đến phiên bạn đang xem. |
| Mở rộng tất cả / Thu gọn tất cả | Mở hoặc đóng mọi dự án (desktop). |
| Tùy chọn thanh bên (`⋯`) | Bố cục, chỉ hiện phiên đang hoạt động, và nhiều hơn nữa. |

## Cần biết {#good-to-know}

- Bạn chỉ mở được các thư mục nằm trong **roots** cho phép (mặc định: thư mục home của bạn). Xem [`--roots`](/vi/reference/cli).
- Thư mục chỉ có phiên từ CLI `claude` hiện là **dự án gần đây** cho đến khi bạn mở chúng.
- Worktree dưới `.claude/worktrees/` có thể được gỡ từ đây, và mọi worktree liên kết nằm trong roots cũng vậy (trừ worktree bị khóa hoặc là symlink), kể cả worktree tạo thủ công. Trước khi gỡ, ứng dụng cho bạn biết sẽ mất bao nhiêu thay đổi chưa commit và bao nhiêu commit.
- Gỡ worktree sẽ xóa nhánh mà claude-code-ui đã tạo cho nó (từ **Ticket**, **Tên**, tên tự tạo hoặc một worker). Nhánh bạn checkout bằng **Nhánh**, hoặc tự tạo, vẫn còn; [Dọn dẹp](/vi/features/clean-up) đề nghị xóa nó khi đã được merge.
- Với WSL hoặc Docker, **Mở dự án** cũng cho phép bạn chọn một môi trường. Xem [WSL & Docker](/vi/features/wsl-docker).
