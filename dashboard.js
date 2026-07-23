(() => {
  const token = localStorage.getItem('voteusToken');
  const accountName = document.querySelector('#accountName');
  const eventsElement = document.querySelector('#events');
  const notice = document.querySelector('#notice');
  const manager = document.querySelector('#manager');
  const managerTitle = document.querySelector('#managerTitle');
  const categoriesElement = document.querySelector('#categories');
  const nomineesElement = document.querySelector('#nominees');
  const ticketsElement = document.querySelector('#tickets');
  const teamMembersElement = document.querySelector('#teamMembers');
  const nomineeCategory = document.querySelector('#nomineeCategory');
  const nomineeEmailLabel = document.createElement('label'); nomineeEmailLabel.htmlFor = 'nomineeEmail'; nomineeEmailLabel.textContent = 'Nominee email address'; const nomineeEmail = document.createElement('input'); nomineeEmail.id = 'nomineeEmail'; nomineeEmail.name = 'email'; nomineeEmail.type = 'email'; nomineeEmail.autocomplete = 'email'; nomineeEmail.required = true; nomineeEmail.placeholder = 'nominee@example.com'; nomineeEmailLabel.append(nomineeEmail); nomineeCategory.closest('label').before(nomineeEmailLabel);
  const paymentEnabled = document.querySelector('#paymentEnabled');
  const paymentAmount = document.querySelector('#paymentAmount');
  const paymentCurrency = document.querySelector('#paymentCurrency');
  const organizerPayout = document.querySelector('#organizerPayout');
  const revenueDetail = document.querySelector('#revenueDetail');
  const withdrawalForm = document.querySelector('#withdrawalForm');
  const withdrawalMethod = document.querySelector('#withdrawalMethod');
  const mobileFields = document.querySelector('#mobileFields');
  const bankFields = document.querySelector('#bankFields');
  const withdrawalNotice = document.querySelector('#withdrawalNotice');
  const withdrawalHistory = document.querySelector('#withdrawalHistory');
  const profileForm = document.querySelector('#profileForm');
  const profileNotice = document.querySelector('#profileNotice');
  const deleteModal = document.querySelector('#deleteModal');
  const deleteModalText = document.querySelector('#deleteModalText');
  let pendingDelete = null;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token || ''}` };
  let selectedEventId = null;

  function showNotice(message, error = false) {
    notice.textContent = message;
    notice.style.color = error ? '#b53e32' : '#0a7b61';
    notice.style.display = 'block';
  }
  function toDateTimeLocal(value) {
    if (!value) return '';
    const date = new Date(value);
    const offset = date.getTimezoneOffset() * 60_000;
    return new Date(date.getTime() - offset).toISOString().slice(0, 16);
  }
  function syncPaymentInputs() {
    paymentAmount.disabled = !paymentEnabled.checked;
    paymentCurrency.disabled = !paymentEnabled.checked;
  }
  function syncWithdrawalFields() {
    const mobile = withdrawalMethod.value === 'mobile-money';
    mobileFields.hidden = !mobile; bankFields.hidden = mobile;
    document.querySelector('#withdrawalMobileNumber').required = mobile;
    ['#withdrawalBankName', '#withdrawalAccountName', '#withdrawalAccountNumber'].forEach(selector => document.querySelector(selector).required = !mobile);
  }
  function showWithdrawalNotice(message, error = false) {
    withdrawalNotice.textContent = message;
    withdrawalNotice.style.color = error ? '#b53e32' : '#0a7b61';
    withdrawalNotice.style.display = 'block';
  }
  function showProfileNotice(message, error = false) {
    profileNotice.textContent = message;
    profileNotice.style.color = error ? '#b53e32' : '#0a7b61';
    profileNotice.style.display = 'block';
  }
  async function request(url, options = {}) {
    const response = await fetch(url, { ...options, headers: { ...headers, ...(options.headers || {}) } });
    const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Unable to complete this request.');
    return data;
  }
  function openDeleteModal(event) { pendingDelete = event; deleteModalText.textContent = `Delete ${event.name}? This action cannot be undone.`; deleteModal.hidden = false; document.querySelector('#confirmDelete').focus(); }
  function closeDeleteModal() { pendingDelete = null; deleteModal.hidden = true; }
  function eventCard(event) {
    const card = document.createElement('article'); card.className = 'event'; card.dataset.eventId = event.id; card.dataset.eventName = event.name;
    const info = document.createElement('div');
    const titleRow = document.createElement('div'); titleRow.className = 'event-title-row';
    const title = document.createElement('h3'); title.textContent = event.name;
    const status = document.createElement('span'); status.className = 'status'; status.textContent = 'Active';
    titleRow.append(title, status);
    const meta = document.createElement('div'); meta.className = 'event-meta';
    meta.innerHTML = `<span><i data-lucide="calendar"></i>Created ${new Date(event.createdAt).toLocaleDateString()}</span><span><i data-lucide="bar-chart-3"></i>Manage votes & revenue</span>`;
    info.append(titleRow, meta);
    const actions = document.createElement('div'); actions.className = 'actions';
    const manage = document.createElement('button'); manage.className = 'action'; manage.type = 'button'; manage.innerHTML = '<i data-lucide="settings-2"></i>Manage';
    manage.addEventListener('click', () => openManager(event.id));
    const rename = document.createElement('button'); rename.className = 'action'; rename.type = 'button'; rename.innerHTML = '<i data-lucide="pencil"></i>Edit';
    rename.addEventListener('click', async () => { const name = window.prompt('New event name', event.name); if (!name || name === event.name) return; try { await request(`/api/events/${event.id}`, { method: 'PATCH', body: JSON.stringify({ name }) }); await loadEvents(); } catch (error) { showNotice(error.message, true); } });
    const remove = document.createElement('button'); remove.className = 'action delete'; remove.type = 'button'; remove.textContent = 'Delete';
    remove.addEventListener('click', async () => { if (!window.confirm(`Delete “${event.name}”? This cannot be undone.`)) return; try { await request(`/api/events/${event.id}`, { method: 'DELETE' }); await loadEvents(); } catch (error) { showNotice(error.message, true); } });
    const rankings = document.createElement('a'); rankings.className = 'action'; rankings.href = `rankings.html?event=${encodeURIComponent(event.id)}`; rankings.innerHTML = '<i data-lucide="trophy"></i>Rankings';
    actions.append(manage, rankings, rename, remove); card.append(info, actions); window.lucide?.createIcons(); return card;
  }
  function listItem(name, detail, onDelete) {
    const item = document.createElement('li');
    const copy = document.createElement('div');
    const title = document.createElement('strong'); title.textContent = name;
    const meta = document.createElement('div'); meta.className = 'small'; meta.textContent = detail;
    copy.append(title, meta);
    const remove = document.createElement('button'); remove.className = 'action delete'; remove.type = 'button'; remove.textContent = 'Delete'; remove.addEventListener('click', onDelete);
    item.append(copy, remove); return item;
  }
  function renderManager(event) {
    manager.hidden = false; managerTitle.textContent = event.name;
    document.querySelector('#managedName').value = event.name;
    document.querySelector('#eventDescription').value = event.description || '';
    document.querySelector('#eventVenue').value = event.venue || '';
    document.querySelector('#eventStartAt').value = toDateTimeLocal(event.eventStartAt);
    document.querySelector('#eventEndAt').value = toDateTimeLocal(event.eventEndAt);
    document.querySelector('#startAt').value = toDateTimeLocal(event.startAt);
    document.querySelector('#endAt').value = toDateTimeLocal(event.endAt);
    const payment = event.payment || { enabled: false, amount: 0, currency: 'USD' };
    paymentEnabled.checked = payment.enabled;
    paymentAmount.value = payment.amount;
    paymentCurrency.value = payment.currency;
    syncPaymentInputs();
    const revenue = event.revenue || { paidVotes: 0, gross: 0, platformFee: 0, organizerPayout: 0, currency: payment.currency };
    const money = value => `${Number(value || 0).toFixed(2)} ${revenue.currency}`;
    organizerPayout.textContent = money(revenue.organizerPayout);
    revenueDetail.textContent = `${revenue.paidVotes} paid vote${revenue.paidVotes === 1 ? '' : 's'} · Gross: ${money(revenue.gross)} · Platform fee: ${money(revenue.platformFee)}`;
    nomineeCategory.replaceChildren();
    const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = event.categories.length ? 'Choose a category' : 'Add a category first'; nomineeCategory.append(placeholder);
    event.categories.forEach(category => { const option = document.createElement('option'); option.value = category.id; option.textContent = category.name; nomineeCategory.append(option); });
    nomineeCategory.disabled = event.categories.length === 0;
    categoriesElement.replaceChildren(); nomineesElement.replaceChildren(); ticketsElement.replaceChildren(); teamMembersElement.replaceChildren();
    if (!event.categories.length) { const empty = document.createElement('li'); empty.className = 'small'; empty.textContent = 'No categories yet.'; categoriesElement.append(empty); }
    event.categories.forEach(category => categoriesElement.append(listItem(category.name, `${event.nominees.filter(nominee => nominee.categoryId === category.id).length} nominee(s)`, async () => { if (!window.confirm(`Delete “${category.name}” and its nominees?`)) return; try { await request(`/api/events/${selectedEventId}/categories/${category.id}`, { method: 'DELETE' }); await openManager(selectedEventId); } catch (error) { showNotice(error.message, true); } })));
    if (!event.nominees.length) { const empty = document.createElement('li'); empty.className = 'small'; empty.textContent = 'No nominees yet.'; nomineesElement.append(empty); }
    event.nominees.forEach(nominee => { const category = event.categories.find(item => item.id === nominee.categoryId); const detail = `${category ? category.name : 'Uncategorised'} · Code: ${nominee.code || 'Pending'} · ${nominee.email || 'No email'} · Invitation: ${nominee.invitation?.status || 'not sent'}`; nomineesElement.append(listItem(nominee.name, detail, async () => { if (!window.confirm(`Delete “${nominee.name}”?`)) return; try { await request(`/api/events/${selectedEventId}/nominees/${nominee.id}`, { method: 'DELETE' }); await openManager(selectedEventId); } catch (error) { showNotice(error.message, true); } })); });
    const tickets = event.tickets || [];
    if (!tickets.length) { const empty = document.createElement('li'); empty.className = 'small'; empty.textContent = 'No tickets created yet.'; ticketsElement.append(empty); }
    tickets.forEach(ticket => ticketsElement.append(listItem(ticket.name, `${Number(ticket.price).toFixed(2)} ${ticket.currency} · ${ticket.quantity} available · Mobile money · 7% platform fee`, async () => { if (!window.confirm(`Delete “${ticket.name}”?`)) return; try { await request(`/api/events/${selectedEventId}/tickets/${ticket.id}`, { method: 'DELETE' }); await openManager(selectedEventId); } catch (error) { showNotice(error.message, true); } })));
    const team = event.team || [];
    if (!team.length) { const empty = document.createElement('li'); empty.className = 'small'; empty.textContent = 'No verification staff or promoters added yet.'; teamMembersElement.append(empty); }
    team.forEach(member => { const label = member.role === 'verifier' ? 'Ticket verifier' : 'Promoter'; const detail = `${label} · ${member.email}${member.accessCode ? ` · Access code: ${member.accessCode}` : ''}`; teamMembersElement.append(listItem(member.name, detail, async () => { if (!window.confirm(`Remove “${member.name}” from this event?`)) return; try { await request(`/api/events/${selectedEventId}/team/${member.id}`, { method: 'DELETE' }); await openManager(selectedEventId); } catch (error) { showNotice(error.message, true); } })); });
  }
  async function openManager(eventId) {
    try { selectedEventId = eventId; const { event } = await request(`/api/events/${eventId}/manage`); renderManager(event); manager.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    catch (error) { showNotice(error.message, true); }
  }
  async function loadEvents() {
    const { events } = await request('/api/events/mine');
    eventsElement.replaceChildren();
    if (!events.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'No events yet. Create your first one to get started.'; eventsElement.append(empty); return; }
    events.forEach(event => eventsElement.append(eventCard(event)));
  }
  async function loadStats() {
    const { stats } = await request('/api/dashboard/stats');
    const money = value => `${Number(value || 0).toFixed(2)} ${stats.currency}`;
    document.querySelector('#statEvents').textContent = stats.events;
    document.querySelector('#statVotes').textContent = stats.votes;
    document.querySelector('#statPayout').textContent = money(stats.organizerPayout);
  }
  async function loadWithdrawals() {
    const { withdrawal } = await request('/api/withdrawals');
    document.querySelector('#availableWithdrawal').textContent = `GHS ${Number(withdrawal.available || 0).toFixed(2)}`;
    document.querySelector('#statPending').textContent = `GHS ${Number(withdrawal.available || 0).toFixed(2)}`;
    document.querySelector('#withdrawalAmount').max = withdrawal.available;
    withdrawalHistory.replaceChildren();
    if (!withdrawal.withdrawals.length) { const item = document.createElement('li'); item.className = 'small'; item.textContent = 'No withdrawal requests yet.'; withdrawalHistory.append(item); return; }
    withdrawal.withdrawals.slice().reverse().forEach(item => { const row = document.createElement('li'); const detail = item.method === 'mobile-money' ? `${item.mobileNetwork} · ${item.mobileNumber}` : `${item.bankName} · ${item.accountNumber}`; row.innerHTML = `<strong></strong><div class="small"></div>`; row.querySelector('strong').textContent = `GHS ${Number(item.amount).toFixed(2)} → GHS ${Number(item.payoutAmount).toFixed(2)} (${item.status})`; row.querySelector('.small').textContent = `${detail} · GHS ${Number(item.fee).toFixed(2)} Paystack fee`; withdrawalHistory.append(row); });
  }
  function setUserDisplay(user) {
    const initials = user.name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || '--';
    accountName.textContent = user.name; document.querySelector('#avatarInitials').textContent = initials; document.querySelector('#profileAvatar').textContent = initials;
    document.querySelector('#welcomeTitle').textContent = `Welcome back, ${user.name.split(/\s+/)[0]} 👋`;
    document.querySelector('#profileDisplayName').textContent = user.name; document.querySelector('#profileDisplayEmail').textContent = user.email;
  }
  async function initialise() {
    try { const { user } = await request('/api/auth/me'); setUserDisplay(user); profileForm.elements.name.value = user.name; profileForm.elements.email.value = user.email; await Promise.all([loadEvents(), loadStats(), loadWithdrawals()]); }
    catch { localStorage.removeItem('voteusToken'); localStorage.removeItem('voteusUser'); window.location.replace('login.html'); }
  }
  document.querySelector('#createEvent').addEventListener('submit', async event => { event.preventDefault(); const form = event.currentTarget; if (!form.reportValidity()) return; try { const { event: created } = await request('/api/events', { method: 'POST', body: JSON.stringify({ name: form.elements.name.value }) }); form.reset(); showNotice(`“${created.name}” was created.`); await Promise.all([loadEvents(), loadStats()]); } catch (error) { showNotice(error.message, true); } });
  document.querySelector('#updateEvent').addEventListener('submit', async event => { event.preventDefault(); const form = event.currentTarget; if (!selectedEventId || !form.reportValidity()) return; const image = form.elements.image.files[0]; if (image && image.size > 2_000_000) return showNotice('Event images must be 2 MB or smaller.', true); try { const imageData = await imageToDataUrl(image); await request(`/api/events/${selectedEventId}`, { method: 'PATCH', body: JSON.stringify({ name: form.elements.name.value, description: form.elements.description.value, venue: form.elements.venue.value, eventStartAt: form.elements.eventStartAt.value || null, eventEndAt: form.elements.eventEndAt.value || null, imageData, startAt: form.elements.startAt.value || null, endAt: form.elements.endAt.value || null, payment: { enabled: paymentEnabled.checked, amount: paymentAmount.value, currency: paymentCurrency.value } }) }); form.elements.image.value = ''; await openManager(selectedEventId); await loadEvents(); showNotice('Event settings updated.'); } catch (error) { showNotice(error.message, true); } });
  document.querySelector('#addCategory').addEventListener('submit', async event => { event.preventDefault(); if (!selectedEventId || !event.currentTarget.reportValidity()) return; try { await request(`/api/events/${selectedEventId}/categories`, { method: 'POST', body: JSON.stringify({ name: event.currentTarget.elements.name.value }) }); event.currentTarget.reset(); await openManager(selectedEventId); } catch (error) { showNotice(error.message, true); } });
  const imageToDataUrl = file => new Promise((resolve, reject) => { if (!file) return resolve(''); const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Unable to read the selected image.')); reader.readAsDataURL(file); });
  document.querySelector('#addNominee').addEventListener('submit', async event => { event.preventDefault(); const form = event.currentTarget; if (!selectedEventId || !form.reportValidity()) return; const image = form.elements.image.files[0]; if (image && image.size > 2_000_000) return showNotice('Images must be 2 MB or smaller.', true); try { const imageData = await imageToDataUrl(image); const result = await request(`/api/events/${selectedEventId}/nominees`, { method: 'POST', body: JSON.stringify({ name: form.elements.name.value, email: form.elements.email.value, categoryId: form.elements.categoryId.value, imageData }) }); form.reset(); await openManager(selectedEventId); showNotice(result.invitation?.status === 'sent' ? 'Nominee added and invitation email sent.' : `Nominee added, but the invitation email could not be sent: ${result.invitation?.error || 'Unknown error.'}`, result.invitation?.status !== 'sent'); } catch (error) { showNotice(error.message, true); } });
  document.querySelector('#addTicket').addEventListener('submit', async event => { event.preventDefault(); const form = event.currentTarget; if (!selectedEventId || !form.reportValidity()) return; try { await request(`/api/events/${selectedEventId}/tickets`, { method: 'POST', body: JSON.stringify({ name: form.elements.name.value, price: form.elements.price.value, currency: form.elements.currency.value, quantity: form.elements.quantity.value, paymentMethod: form.elements.paymentMethod.value }) }); form.reset(); form.elements.price.value = '0'; form.elements.quantity.value = '100'; await openManager(selectedEventId); showNotice('Ticket created with mobile-money payments and a 7% platform fee.'); } catch (error) { showNotice(error.message, true); } });
  document.querySelector('#addTeamMember').addEventListener('submit', async event => { event.preventDefault(); const form = event.currentTarget; if (!selectedEventId || !form.reportValidity()) return; try { const { member } = await request(`/api/events/${selectedEventId}/team`, { method: 'POST', body: JSON.stringify({ name: form.elements.name.value, email: form.elements.email.value, role: form.elements.role.value }) }); form.reset(); await openManager(selectedEventId); showNotice(`${member.role === 'verifier' ? 'Ticket verifier' : 'Promoter'} added.${member.accessCode ? ` Access code: ${member.accessCode}` : ''}`); } catch (error) { showNotice(error.message, true); } });
  profileForm.addEventListener('submit', async event => { event.preventDefault(); if (!profileForm.reportValidity()) return; try { const { user } = await request('/api/auth/profile', { method: 'PATCH', body: JSON.stringify({ name: profileForm.elements.name.value, email: profileForm.elements.email.value }) }); setUserDisplay(user); profileForm.elements.name.value = user.name; profileForm.elements.email.value = user.email; localStorage.setItem('voteusUser', JSON.stringify(user)); showProfileNotice('Profile updated.'); } catch (error) { showProfileNotice(error.message, true); } });
  withdrawalMethod.addEventListener('change', syncWithdrawalFields);
  withdrawalForm.addEventListener('submit', async event => { event.preventDefault(); if (!withdrawalForm.reportValidity()) return; try { const form = withdrawalForm.elements; const result = await request('/api/withdrawals', { method: 'POST', body: JSON.stringify({ amount: form.amount.value, method: form.method.value, mobileNetwork: form.mobileNetwork.value, mobileNumber: form.mobileNumber.value, bankName: form.bankName.value, accountName: form.accountName.value, accountNumber: form.accountNumber.value }) }); showWithdrawalNotice(`${result.message} You will receive GHS ${Number(result.withdrawal.payoutAmount).toFixed(2)} after the fee.`); withdrawalForm.reset(); syncWithdrawalFields(); await loadWithdrawals(); } catch (error) { showWithdrawalNotice(error.message, true); } });
  document.querySelector('#closeManager').addEventListener('click', () => { manager.hidden = true; selectedEventId = null; });
  document.querySelector('#cancelDelete').addEventListener('click', closeDeleteModal);
  deleteModal.addEventListener('click', event => { if (event.target === deleteModal) closeDeleteModal(); });
  document.querySelector('#confirmDelete').addEventListener('click', async () => { if (!pendingDelete) return; const event = pendingDelete; closeDeleteModal(); try { await request(`/api/events/${event.id}`, { method: 'DELETE' }); await Promise.all([loadEvents(), loadStats(), loadWithdrawals()]); } catch (error) { showNotice(error.message, true); } });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !deleteModal.hidden) closeDeleteModal(); });
  document.addEventListener('click', event => { const button = event.target.closest('.event .action.delete'); if (!button) return; event.preventDefault(); event.stopPropagation(); openDeleteModal({ id: button.closest('.event').dataset.eventId, name: button.closest('.event').dataset.eventName }); }, true);
  const sidebar = document.querySelector('#sidebar'); const scrim = document.querySelector('#scrim'); const menuToggle = document.querySelector('#menuToggle');
  const campaignLink = document.createElement('a'); campaignLink.href = 'campaigns.html'; campaignLink.innerHTML = '<i data-lucide="megaphone"></i>Create campaign'; document.querySelector('.side-nav').append(campaignLink); window.lucide?.createIcons();
  function closeNavigation() { sidebar.classList.remove('is-open'); scrim.classList.remove('is-open'); menuToggle.setAttribute('aria-expanded', 'false'); }
  menuToggle.addEventListener('click', () => { const open = sidebar.classList.toggle('is-open'); scrim.classList.toggle('is-open', open); menuToggle.setAttribute('aria-expanded', String(open)); });
  scrim.addEventListener('click', closeNavigation);
  document.querySelectorAll('.side-nav a').forEach(link => link.addEventListener('click', () => { document.querySelectorAll('.side-nav a').forEach(item => item.classList.remove('active')); link.classList.add('active'); closeNavigation(); }));
  paymentEnabled.addEventListener('change', syncPaymentInputs);
  syncWithdrawalFields();
  document.querySelector('#logout').addEventListener('click', async () => { try { await request('/api/auth/logout', { method: 'POST' }); } finally { localStorage.removeItem('voteusToken'); localStorage.removeItem('voteusUser'); window.location.href = 'index.html'; } });
  initialise();
})();
