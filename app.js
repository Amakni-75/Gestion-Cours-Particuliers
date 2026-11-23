    // System State
    let state = {
      students: [],
      sessions: [],
      payments: {},
      subjects: []
    };

    let supabaseClient = null;
    let currentUser = null;
    let currentProfile = null;
    let saveQueue = Promise.resolve();
    // Lignes réellement présentes en base (dernière lecture ou écriture réussie) :
    // sert de référence pour ne pousser que les différences RÉELLES.
    let persistedRows = null;
    let userDataChannel = null;
    let remoteRefreshTimer = null;
    let isSavingData = false;
    let pendingSaveCount = 0;
    let currentDate = new Date();
    let dashboardMonths = [];
    let dashboardStudent = 'all';
    let activeAppScreen = 'dashboard';

    function showAuthMessage(message, isError = false) {
      const element = document.getElementById('authMessage');
      element.innerText = message;
      element.className = `mt-4 text-sm rounded-lg p-3 ${isError
        ? 'bg-rose-50 text-rose-800 border border-rose-200'
        : 'bg-indigo-50 text-indigo-800 border border-indigo-200'}`;
    }

    function getSupabaseError(error) {
      return error?.message || "Une erreur inattendue est survenue.";
    }

    function getAppRedirectUrl() {
      return `${window.location.origin}${window.location.pathname}`;
    }

    function navigateApp(screen) {
      const allowedScreens = ['dashboard', 'students', 'subjects', 'sessions', 'memberships'];
      if (!allowedScreens.includes(screen) || (screen === 'memberships' && currentProfile?.role !== 'admin')) {
        return;
      }

      activeAppScreen = screen;
      const showCalendarAndPayments = ['dashboard', 'sessions'].includes(screen);
      document.getElementById('dashboardScreen').classList.toggle('hidden', screen !== 'dashboard');
      document.getElementById('recordsGrid').classList.toggle(
        'hidden',
        !['dashboard', 'students', 'subjects', 'sessions'].includes(screen)
      );
      document.getElementById('recordsColumn').classList.remove('hidden');
      document.getElementById('studentsCard').classList.toggle('hidden', screen !== 'students');
      document.getElementById('catalogSubjectsCard').classList.toggle('hidden', screen !== 'subjects');
      document.getElementById('paymentsCard').classList.toggle('hidden', !showCalendarAndPayments);
      document.getElementById('calendarCard').classList.toggle('hidden', !showCalendarAndPayments);
      document.getElementById('adminPendingUsers').classList.toggle('hidden', screen !== 'memberships');
      document.getElementById('recordsGrid').classList.toggle('lg:grid-cols-1', !showCalendarAndPayments);
      document.getElementById('recordsGrid').classList.toggle('lg:grid-cols-3', showCalendarAndPayments);
      document.getElementById('calendarCard').classList.toggle('lg:col-span-2', showCalendarAndPayments);
      document.getElementById('recordsColumn').classList.toggle('lg:col-span-1', showCalendarAndPayments);
      document.getElementById('appNavigation').classList.remove('hidden');

      document.querySelectorAll('.app-nav-button').forEach(button => {
        const isActive = button.dataset.screen === screen;
        button.classList.toggle('bg-indigo-600', isActive);
        button.classList.toggle('text-white', isActive);
        button.classList.toggle('text-slate-600', !isActive);
        button.classList.toggle('hover:bg-slate-100', !isActive);
        if (isActive) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      });
    }

    async function authenticate(event) {
      event.preventDefault();
      if (!supabaseClient) return showAuthMessage("Configurez Supabase dans supabase-config.js avant de vous connecter.", true);
      const email = document.getElementById('authEmail').value.trim();
      const password = document.getElementById('authPassword').value;
      try {
        const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) showAuthMessage(`Connexion impossible : ${getSupabaseError(error)}`, true);
      } catch (error) {
        showAuthMessage(`Connexion impossible : ${getSupabaseError(error)}`, true);
      }
    }

    async function signUp() {
      if (!supabaseClient) return showAuthMessage("Configurez Supabase dans supabase-config.js avant de créer un compte.", true);
      const form = document.getElementById('authForm');
      if (!form.reportValidity()) return;
      const email = document.getElementById('authEmail').value.trim();
      const password = document.getElementById('authPassword').value;
      try {
        const { data, error } = await supabaseClient.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: getAppRedirectUrl() }
        });
        if (error) {
          showAuthMessage(`Création du compte impossible : ${getSupabaseError(error)}`, true);
          return;
        }
        if (!data.session) {
          showAuthMessage("Compte créé. Confirmez votre adresse e-mail, puis connectez-vous. Votre accès devra ensuite être approuvé par un administrateur.");
        } else {
          showAuthMessage("Compte créé. Votre accès est en attente d'approbation par un administrateur.");
        }
      } catch (error) {
        showAuthMessage(`Création du compte impossible : ${getSupabaseError(error)}`, true);
      }
    }

    async function resendConfirmationEmail() {
      if (!supabaseClient) {
        showAuthMessage("Configurez Supabase dans supabase-config.js avant de demander un lien de confirmation.", true);
        return;
      }
      const email = document.getElementById('authEmail').value.trim();
      if (!email) {
        showAuthMessage("Saisissez votre adresse e-mail avant de demander un nouveau lien.", true);
        return;
      }
      try {
        const { error } = await supabaseClient.auth.resend({
          type: 'signup',
          email,
          options: { emailRedirectTo: getAppRedirectUrl() }
        });
        if (error) {
          showAuthMessage(`Renvoi impossible : ${getSupabaseError(error)}`, true);
          return;
        }
        showAuthMessage("Un nouveau lien de confirmation a été envoyé. Utilisez le dernier e-mail reçu : les anciens liens peuvent expirer ou avoir déjà été utilisés.");
      } catch (error) {
        showAuthMessage(`Renvoi impossible : ${getSupabaseError(error)}`, true);
      }
    }

    async function signOut() {
      if (!supabaseClient) return;
      try {
        const { error } = await supabaseClient.auth.signOut();
        if (error) showAuthMessage(`Déconnexion impossible : ${getSupabaseError(error)}`, true);
      } catch (error) {
        showAuthMessage(`Déconnexion impossible : ${getSupabaseError(error)}`, true);
      }
    }

    async function refreshApproval() {
      if (!supabaseClient) return;
      const { data, error } = await supabaseClient.auth.getSession();
      if (error) {
        showAuthMessage(`Vérification impossible : ${getSupabaseError(error)}`, true);
        return;
      }
      try {
        currentProfile = null;
        await handleSession(data.session);
      } catch (profileError) {
        showAuthMessage(getSupabaseError(profileError), true);
      }
    }

    function showSignedOut() {
      if (userDataChannel && supabaseClient) {
        supabaseClient.removeChannel(userDataChannel);
        userDataChannel = null;
      }
      currentUser = null;
      currentProfile = null;
      persistedRows = null;
      state = { students: [], sessions: [], payments: {}, subjects: [] };
      document.getElementById('appContent').classList.add('hidden');
      document.getElementById('authScreen').classList.remove('hidden');
      document.getElementById('signOutButton').classList.add('hidden');
      document.getElementById('signOutButton').classList.remove('flex');
      document.getElementById('currentUserLabel').classList.add('hidden');
      document.getElementById('appActions').classList.add('hidden');
      document.getElementById('appNavigation').classList.add('hidden');
      document.getElementById('pendingSignOutButton').classList.add('hidden');
      document.getElementById('refreshApprovalButton').classList.add('hidden');
      document.getElementById('authForm').classList.remove('hidden');
      activeAppScreen = 'dashboard';
    }

    async function handleSession(session) {
      if (!session?.user) {
        showSignedOut();
        return;
      }

      if (currentUser && currentUser.id !== session.user.id) {
        if (userDataChannel) {
          supabaseClient.removeChannel(userDataChannel);
          userDataChannel = null;
        }
        state = { students: [], sessions: [], payments: {}, subjects: [] };
        currentProfile = null;
        persistedRows = null;
      }
      currentUser = session.user;
      if (currentProfile?.id === currentUser.id) return;
      const { data: profile, error } = await supabaseClient
        .from('profiles')
        .select('id, email, status, role')
        .eq('id', currentUser.id)
        .single();
      if (error) throw new Error(`Impossible de vérifier le profil : ${getSupabaseError(error)}`);
      currentProfile = profile;
      document.getElementById('authForm').classList.add('hidden');

      if (profile.status !== 'approved') {
        document.getElementById('appContent').classList.add('hidden');
        document.getElementById('authScreen').classList.remove('hidden');
        document.getElementById('currentUserLabel').classList.add('hidden');
        document.getElementById('signOutButton').classList.add('hidden');
        document.getElementById('signOutButton').classList.remove('flex');
        document.getElementById('appActions').classList.add('hidden');
        document.getElementById('pendingSignOutButton').classList.remove('hidden');
        document.getElementById('refreshApprovalButton').classList.remove('hidden');
        showAuthMessage(profile.status === 'rejected'
          ? "Votre demande d'accès a été refusée. Contactez l'administrateur si vous pensez qu'il s'agit d'une erreur."
          : "Votre compte est en attente de validation par un administrateur.");
        return;
      }

      document.getElementById('authScreen').classList.add('hidden');
      document.getElementById('pendingSignOutButton').classList.add('hidden');
      document.getElementById('refreshApprovalButton').classList.add('hidden');
      document.getElementById('appContent').classList.remove('hidden');
      document.getElementById('currentUserLabel').innerText = profile.email;
      document.getElementById('currentUserLabel').classList.remove('hidden');
      document.getElementById('signOutButton').classList.remove('hidden');
      document.getElementById('signOutButton').classList.add('flex');
      document.getElementById('appActions').classList.remove('hidden');
      document.getElementById('appActions').classList.add('flex');
      document.getElementById('adminNavigationButton').classList.toggle('hidden', profile.role !== 'admin');
      navigateApp(profile.role === 'admin' && activeAppScreen === 'memberships' ? 'memberships' : 'dashboard');
      await loadUserData();
      subscribeToUserData();
      if (profile.role === 'admin') {
        document.getElementById('adminPendingUsers').classList.remove('hidden');
        await loadPendingUsers();
      } else {
        document.getElementById('adminPendingUsers').classList.add('hidden');
      }
    }

    async function loadPendingUsers() {
      if (currentProfile?.role !== 'admin') return;
      const { data, error } = await supabaseClient
        .from('profiles')
        .select('id, email, created_at')
        .eq('status', 'pending')
        .order('created_at', { ascending: true });
      if (error) {
        showToast(`Chargement des demandes impossible : ${getSupabaseError(error)}`, true);
        return;
      }

      const container = document.getElementById('adminPendingUsersList');
      container.innerHTML = data.length ? data.map(profile => `
        <div class="flex flex-wrap justify-between items-center gap-2 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
          <div>
            <span class="text-sm font-semibold text-slate-800">${escapeHTML(profile.email)}</span>
            <span class="block text-xs text-slate-500">Inscription : ${new Date(profile.created_at).toLocaleDateString('fr-FR')}</span>
          </div>
          <div class="flex gap-2">
            <button type="button" onclick="updateUserApproval('${profile.id}', 'approved')" class="bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg px-3 py-1.5 text-xs font-semibold">Approuver</button>
            <button type="button" onclick="updateUserApproval('${profile.id}', 'rejected')" class="bg-white hover:bg-rose-50 text-rose-700 border border-rose-200 rounded-lg px-3 py-1.5 text-xs font-semibold">Refuser</button>
          </div>
        </div>
      `).join('') : `<p class="text-sm text-slate-500">Aucune demande en attente.</p>`;
    }

    async function updateUserApproval(userId, status) {
      if (currentProfile?.role !== 'admin' || !['approved', 'rejected'].includes(status)) {
        showToast("Action réservée à l'administrateur.", true);
        return;
      }
      const { error } = await supabaseClient
        .from('profiles')
        .update({ status, updated_at: new Date().toISOString() })
        .eq('id', userId)
        .eq('status', 'pending');
      if (error) {
        showToast(`Mise à jour du compte impossible : ${getSupabaseError(error)}`, true);
        return;
      }
      showToast(status === 'approved' ? "Compte approuvé." : "Demande refusée.");
      await loadPendingUsers();
    }

    async function initializeApplication() {
      const config = window.APP_CONFIG;
      if (!window.supabase?.createClient || !config?.supabaseUrl || !config?.supabaseAnonKey) {
        showAuthMessage("Avant utilisation, renseignez l'URL de votre projet et sa clé publishable/anon dans supabase-config.js. N'utilisez jamais la clé service_role ici.", true);
        return;
      }

      supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
      supabaseClient.auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_OUT') {
          showSignedOut();
        } else if (session) {
          setTimeout(() => handleSession(session).catch(error => {
            console.error(error);
            showAuthMessage(getSupabaseError(error), true);
          }), 0);
        }
      });
      window.addEventListener('focus', refreshUserData);

      const { data, error } = await supabaseClient.auth.getSession();
      if (error) throw new Error(`Impossible de restaurer la session : ${getSupabaseError(error)}`);
      if (data.session) await handleSession(data.session);
    }

    async function checkSupabaseResult(result, action) {
      if (result.error) {
        const { message, details, hint, code } = result.error;
        const extra = [details, hint, code && `code ${code}`].filter(Boolean).join(' — ');
        throw new Error(`${action} : ${message || getSupabaseError(result.error)}${extra ? ` (${extra})` : ''}`);
      }
      return result.data;
    }

    // Normalise les lignes lues en base dans la MÊME forme (mêmes clés, même ordre)
    // que buildUserDataRows, pour une comparaison JSON fiable.
    function toPersistedRows(studentRows, subjectRows, assignmentRows, cycleRows, sessionRows) {
      return {
        studentRows: studentRows.map(row => ({
          student_id: row.student_id, owner_id: row.owner_id, full_name: row.full_name, email: row.email || null
        })),
        subjectRows: subjectRows.map(row => ({
          subject_id: row.subject_id, owner_id: row.owner_id, name: row.name
        })),
        assignmentRows: assignmentRows.map(row => ({
          assignment_id: row.assignment_id,
          owner_id: row.owner_id,
          student_id: row.student_id,
          subject_id: row.subject_id,
          rate_millimes: row.rate_millimes
        })),
        cycleRows: cycleRows.map(row => ({
          payment_cycle_id: row.payment_cycle_id,
          owner_id: row.owner_id,
          student_id: row.student_id,
          subject_id: row.subject_id ?? null,
          cycle_number: row.cycle_number,
          is_paid: row.is_paid === true
        })),
        sessionRows: sessionRows.map(row => ({
          session_id: row.session_id,
          owner_id: row.owner_id,
          student_id: row.student_id,
          subject_id: row.subject_id,
          payment_cycle_id: row.payment_cycle_id,
          session_date: row.session_date,
          start_at: row.start_at || null,
          session_timezone: row.session_timezone || null,
          rate_millimes: row.rate_millimes
        }))
      };
    }

    async function loadUserData() {
      const ownerId = currentUser.id;
      const tables = ['students', 'subjects', 'student_subjects', 'sessions', 'payment_cycles'];
      const results = await Promise.all(tables.map(table =>
        supabaseClient.from(table).select('*').eq('owner_id', ownerId)
      ));
      const rows = await Promise.all(results.map((result, index) =>
        checkSupabaseResult(result, `Lecture ${tables[index]} impossible`)
      ));
      const [studentRows, subjectRows, assignmentRows, sessionRows, cycleRows] = rows;

      state.students = studentRows.map(row => ({
        id: row.student_id, name: row.full_name, email: row.email || '', subjects: []
      }));
      state.subjects = subjectRows.map(row => ({ id: row.subject_id, name: row.name }));
      const studentsById = new Map(state.students.map(student => [student.id, student]));
      assignmentRows.forEach(row => {
        const student = studentsById.get(row.student_id);
        const subject = state.subjects.find(item => item.id === row.subject_id);
        if (student && subject) student.subjects.push({ id: subject.id, name: subject.name, rate: row.rate_millimes / 1000 });
      });
      state.sessions = sessionRows.map(row => ({
        id: row.session_id,
        date: row.session_date,
        startAt: row.start_at,
        timeZone: row.session_timezone,
        studentId: row.student_id,
        subjectId: row.subject_id,
        rate: row.rate_millimes / 1000
      }));
      // Reconstruction des paiements à partir de l'appartenance des séances, et non
      // du numéro de cycle stocké. Tolère l'ancien format de payment_cycle_id comme
      // le nouveau : les paiements existants sont ainsi migrés automatiquement.
      const paidByCycleId = new Map();
      cycleRows.forEach(row => paidByCycleId.set(row.payment_cycle_id, row.is_paid === true));
      const subjectGroups = new Map();
      sessionRows.forEach(row => {
        const gkey = `${row.student_id}::${row.subject_id}`;
        let group = subjectGroups.get(gkey);
        if (!group) {
          group = { studentId: row.student_id, subjectId: row.subject_id, items: [] };
          subjectGroups.set(gkey, group);
        }
        group.items.push({ date: row.session_date, id: row.session_id, cycleId: row.payment_cycle_id });
      });
      state.payments = {};
      subjectGroups.forEach(group => {
        group.items.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
        for (let offset = 0; offset < group.items.length; offset += 4) {
          const chunk = group.items.slice(offset, offset + 4);
          const subjectCycleNumber = Math.floor(offset / 4) + 1;
          // Conservateur : réglé seulement si toutes les séances du cycle provenaient
          // d'un cycle déjà réglé (évite de marquer « payé » par erreur).
          const paid = chunk.every(s => paidByCycleId.get(s.cycleId) === true);
          state.payments[cyclePaymentKey(group.studentId, group.subjectId, subjectCycleNumber)] = paid;
        }
      });

      const hasData = studentRows.length || subjectRows.length || sessionRows.length;
      const legacyImported = localStorage.getItem('tutoring_supabase_legacy_import_done') === 'true';
      const legacyStudents = localStorage.getItem('tutoring_students_tnd');
      if (!hasData && !legacyImported && legacyStudents
        && confirm("Importer dans votre compte privé les données actuellement stockées dans ce navigateur ?")) {
        state.students = JSON.parse(legacyStudents);
        state.sessions = JSON.parse(localStorage.getItem('tutoring_sessions_tnd') || '[]');
        state.payments = JSON.parse(localStorage.getItem('tutoring_payments_tnd') || '{}');
        state.subjects = JSON.parse(localStorage.getItem('tutoring_subjects_tnd') || '[]');
        normalizeSubjectCatalog();
        persistedRows = await persistUserData(JSON.parse(JSON.stringify(state)), null);
      } else {
        // Référence = contenu RÉEL de la base (et non un recalcul local) : les séances
        // encore rattachées à un ancien payment_cycle_id seront réécrites, et chaque
        // cycle référencé par une séance sera bien créé avant celle-ci.
        persistedRows = toPersistedRows(studentRows, subjectRows, assignmentRows, cycleRows, sessionRows);
      }
      localStorage.setItem('tutoring_supabase_legacy_import_done', 'true');
      render();
    }

    function scheduleRemoteRefresh() {
      clearTimeout(remoteRefreshTimer);
      remoteRefreshTimer = setTimeout(async () => {
        if (!currentUser || currentProfile?.status !== 'approved') return;
        if (isSavingData || pendingSaveCount > 0) {
          scheduleRemoteRefresh();
          return;
        }
        try {
          await loadUserData();
        } catch (error) {
          console.error(error);
          showToast(`Synchronisation distante impossible : ${getSupabaseError(error)}`, true);
        }
      }, 500);
    }

    function subscribeToUserData() {
      if (userDataChannel) supabaseClient.removeChannel(userDataChannel);
      const ownerId = currentUser.id;
      const tables = ['students', 'subjects', 'student_subjects', 'payment_cycles', 'sessions'];
      let channel = supabaseClient.channel(`private-data-${ownerId}`);
      tables.forEach(table => {
        channel = channel.on('postgres_changes', {
          event: '*',
          schema: 'public',
          table,
          filter: `owner_id=eq.${ownerId}`
        }, scheduleRemoteRefresh);
      });
      userDataChannel = channel.subscribe(status => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          showToast(`La synchronisation en temps réel a échoué (${status}).`, true);
        }
      });
    }

    async function refreshUserData() {
      if (!currentUser || currentProfile?.status !== 'approved'
        || document.visibilityState === 'hidden' || pendingSaveCount > 0) return;
      try {
        await loadUserData();
      } catch (error) {
        console.error(error);
        showToast(`Actualisation impossible : ${getSupabaseError(error)}`, true);
      }
    }

    function toMillimes(rate) {
      const numericRate = Number(rate);
      if (!Number.isFinite(numericRate) || numericRate < 0) throw new Error("Un tarif est invalide.");
      return Math.round(numericRate * 1000);
    }

    async function syncOwnedRows(table, key, rows, baselineRows, deferredDeletes) {
      const ownerId = currentUser.id;
      const previous = new Map(baselineRows.map(row => [row[key], JSON.stringify(row)]));
      const currentIds = new Set(rows.map(row => row[key]));
      const changedRows = rows.filter(row => previous.get(row[key]) !== JSON.stringify(row));
      if (changedRows.length) {
        await checkSupabaseResult(
          await supabaseClient.from(table).upsert(changedRows, { onConflict: key }),
          `Enregistrement ${table} impossible`
        );
      }
      const obsolete = baselineRows.map(row => row[key]).filter(id => !currentIds.has(id));
      if (obsolete.length) deferredDeletes.push(async () => {
        for (let offset = 0; offset < obsolete.length; offset += 100) {
          await checkSupabaseResult(
            await supabaseClient.from(table).delete().eq('owner_id', ownerId).in(key, obsolete.slice(offset, offset + 100)),
            `Suppression ${table} impossible`
          );
        }
      });
    }

    function getStudentSessionCycles(sessions) {
      const sessionsBySubject = new Map();
      sessions.forEach(session => {
        if (!sessionsBySubject.has(session.subjectId)) sessionsBySubject.set(session.subjectId, []);
        sessionsBySubject.get(session.subjectId).push(session);
      });

      const subjectIds = [...sessionsBySubject.keys()].sort();
      const cycles = [];
      let cycleNumber = 0;

      subjectIds.forEach(subjectId => {
        const subjectSessions = sessionsBySubject.get(subjectId);
        if (!subjectSessions) return;
        subjectSessions.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
        for (let offset = 0; offset < subjectSessions.length; offset += 4) {
          cycleNumber++;
          cycles.push({
            cycleNumber,
            subjectCycleNumber: Math.floor(offset / 4) + 1,
            subjectId,
            sessions: subjectSessions.slice(offset, offset + 4)
          });
        }
      });

      return cycles;
    }

    // Identité STABLE d'un cycle de paiement : par (élève, matière, numéro de cycle
    // local à la matière). Ainsi, ajouter une séance à une matière ne renumérote
    // jamais les cycles d'une autre matière (les paiements restent bien attachés).
    function cyclePaymentKey(studentId, subjectId, subjectCycleNumber) {
      return `${studentId}::${subjectId}::cycle${subjectCycleNumber}`;
    }
    function cyclePaymentId(ownerId, studentId, subjectId, subjectCycleNumber) {
      return `${ownerId}:${studentId}:${subjectId}:cycle:${subjectCycleNumber}`;
    }

    // Cycles d'une matière donnée pour un élève (chunks de 4, triés par date).
    // Utilisé pour détecter si une séance touche une échéance déjà réglée.
    function getSubjectCycles(studentId, subjectId, excludeSessionId) {
      const subjectSessions = state.sessions
        .filter(s => s.studentId === studentId && s.subjectId === subjectId
          && s.id !== excludeSessionId)
        .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
      const cycles = [];
      for (let offset = 0; offset < subjectSessions.length; offset += 4) {
        cycles.push({
          subjectCycleNumber: Math.floor(offset / 4) + 1,
          sessions: subjectSessions.slice(offset, offset + 4)
        });
      }
      return cycles;
    }

    // Vrai si une séance datée `newDate` pour (élève, matière) tombe dans — ou avant —
    // une échéance DÉJÀ RÉGLÉE de cette même matière (donc la recomposerait).
    // Une séance strictement postérieure à toutes les échéances réglées renvoie faux.
    function sessionAffectsPaidCycle(studentId, subjectId, newDate, excludeSessionId) {
      let boundaryDate = null;
      getSubjectCycles(studentId, subjectId, excludeSessionId).forEach(cycle => {
        const key = cyclePaymentKey(studentId, subjectId, cycle.subjectCycleNumber);
        if (state.payments[key] && cycle.sessions.length) {
          const lastDate = cycle.sessions[cycle.sessions.length - 1].date;
          if (boundaryDate === null || lastDate > boundaryDate) boundaryDate = lastDate;
        }
      });
      return boundaryDate !== null && newDate <= boundaryDate;
    }

    function buildUserDataRows(snapshot) {
      const ownerId = currentUser.id;
      const studentRows = snapshot.students.map(student => ({
        student_id: student.id, owner_id: ownerId, full_name: student.name, email: student.email || null
      }));
      const subjectRows = snapshot.subjects.map(subject => ({
        subject_id: subject.id, owner_id: ownerId, name: subject.name
      }));
      const assignmentRows = snapshot.students.flatMap(student => (student.subjects || []).map(subject => ({
        assignment_id: `${ownerId}:${student.id}:${subject.id}`,
        owner_id: ownerId,
        student_id: student.id,
        subject_id: subject.id,
        rate_millimes: toMillimes(subject.rate)
      })));

      const cycleRows = [];
      const sessionRows = [];
      snapshot.students.forEach(student => {
        const sessions = snapshot.sessions.filter(session => session.studentId === student.id)
          .slice();
        getStudentSessionCycles(sessions).forEach(cycle => {
          const paymentCycleId = cyclePaymentId(ownerId, student.id, cycle.subjectId, cycle.subjectCycleNumber);
          const paymentKey = cyclePaymentKey(student.id, cycle.subjectId, cycle.subjectCycleNumber);
          cycleRows.push({
            payment_cycle_id: paymentCycleId,
            owner_id: ownerId,
            student_id: student.id,
            subject_id: cycle.subjectId,
            cycle_number: cycle.subjectCycleNumber,
            is_paid: Boolean(snapshot.payments[paymentKey])
          });
          cycle.sessions.forEach(session => {
            sessionRows.push({
              session_id: session.id,
              owner_id: ownerId,
              student_id: student.id,
              subject_id: session.subjectId,
              payment_cycle_id: paymentCycleId,
              session_date: session.date,
              start_at: session.startAt || null,
              session_timezone: session.timeZone || null,
              rate_millimes: toMillimes(getSessionPrice(
                session,
                student.subjects.find(subject => subject.id === session.subjectId)
              ))
            });
          });
        });
      });
      return { studentRows, subjectRows, assignmentRows, cycleRows, sessionRows };
    }

    // `baseline` = lignes présentes en base (forme de buildUserDataRows), ou null.
    // Renvoie les lignes écrites, qui deviennent la nouvelle référence.
    async function persistUserData(snapshot, baseline = persistedRows) {
      const rows = buildUserDataRows(snapshot);
      const previous = baseline || {
        studentRows: [], subjectRows: [], assignmentRows: [], cycleRows: [], sessionRows: []
      };
      const deferredDeletes = [];

      await syncOwnedRows('students', 'student_id', rows.studentRows, previous.studentRows, deferredDeletes);
      await syncOwnedRows('subjects', 'subject_id', rows.subjectRows, previous.subjectRows, deferredDeletes);
      await syncOwnedRows('payment_cycles', 'payment_cycle_id', rows.cycleRows, previous.cycleRows, deferredDeletes);
      await syncOwnedRows('student_subjects', 'assignment_id', rows.assignmentRows, previous.assignmentRows, deferredDeletes);
      await syncOwnedRows('sessions', 'session_id', rows.sessionRows, previous.sessionRows, deferredDeletes);
      // Suppressions dans l'ordre inverse des dépendances (séances d'abord).
      for (const deleteObsolete of deferredDeletes.reverse()) await deleteObsolete();
      return rows;
    }

    function saveData() {
      if (!currentUser) {
        showToast("Connectez-vous avant de modifier les données.", true);
        return;
      }
      const snapshot = JSON.parse(JSON.stringify(state));
      pendingSaveCount++;
      saveQueue = saveQueue.then(async () => {
        isSavingData = true;
        try {
          persistedRows = await persistUserData(snapshot);
        } finally {
          isSavingData = false;
        }
        render();
      }).catch(async error => {
        console.error(error);
        showToast(`Synchronisation impossible : ${getSupabaseError(error)}`, true);
        try {
          await loadUserData();
        } catch (reloadError) {
          console.error(reloadError);
          showToast(`Rechargement des données impossible : ${getSupabaseError(reloadError)}`, true);
        }
      }).finally(() => {
        pendingSaveCount = Math.max(0, pendingSaveCount - 1);
      });
    }

    function normalizeSubjectCatalog() {
      const subjectsById = new Map();
      const subjectsByName = new Map();
      const subjectIdsByStudent = new Map();
      const catalog = [];
      let generatedId = 0;

      const addCatalogSubject = (id, name) => {
        const normalizedName = String(name || '').trim();
        if (!normalizedName) return null;

        const nameKey = normalizedName.toLocaleLowerCase('fr');
        const existing = subjectsByName.get(nameKey) || subjectsById.get(id);
        if (existing) {
          if (id) subjectsById.set(id, existing);
          return existing;
        }

        const subject = {
          id: String(id || `sub_${Date.now()}_${generatedId++}`),
          name: normalizedName
        };
        catalog.push(subject);
        subjectsById.set(subject.id, subject);
        subjectsByName.set(nameKey, subject);
        return subject;
      };

      (state.subjects || []).forEach(subject => {
        const normalized = addCatalogSubject(subject.id, subject.name);
        if (normalized && subject.id) subjectsById.set(String(subject.id), normalized);
      });

      state.students.forEach(student => {
        const assignmentIds = new Map();
        student.subjects = (student.subjects || []).map(assignment => {
          const previousId = String(assignment.id || assignment.subjectId || '');
          const subject = addCatalogSubject(previousId, assignment.name);
          if (!subject) return null;
          if (previousId) assignmentIds.set(previousId, subject.id);
          return { id: subject.id, name: subject.name, rate: assignment.rate };
        }).filter(Boolean);
        subjectIdsByStudent.set(student.id, assignmentIds);
      });

      state.sessions.forEach(session => {
        const assignmentIds = subjectIdsByStudent.get(session.studentId);
        const mappedId = assignmentIds?.get(String(session.subjectId)) || subjectsById.get(String(session.subjectId))?.id;
        if (mappedId) session.subjectId = mappedId;
      });

      state.subjects = catalog;
    }

    function buildRenderIndex() {
      const studentsById = new Map();
      const subjectsById = new Map(state.subjects.map(subject => [subject.id, subject]));
      const subjectsByStudent = new Map();
      const sessionsByDate = new Map();
      const sessionsByStudent = new Map();

      state.students.forEach(student => {
        studentsById.set(student.id, student);
        subjectsByStudent.set(
          student.id,
          new Map((student.subjects || []).map(subject => [subject.id, subject]))
        );
      });

      state.sessions.forEach(session => {
        const dateSessions = sessionsByDate.get(session.date) || [];
        dateSessions.push(session);
        sessionsByDate.set(session.date, dateSessions);

        const studentSessions = sessionsByStudent.get(session.studentId) || [];
        studentSessions.push(session);
        sessionsByStudent.set(session.studentId, studentSessions);
      });

      return { studentsById, subjectsById, subjectsByStudent, sessionsByDate, sessionsByStudent };
    }

    function getSessionPrice(session, subject) {
      return session.rate !== undefined ? session.rate : (subject ? subject.rate : 0);
    }

    function showToast(message, isError = false) {
      const toast = document.getElementById('toast');
      const toastMsg = document.getElementById('toastMsg');
      const toastIcon = document.getElementById('toastIcon');

      toastMsg.innerText = message;
      if (isError) {
        toastIcon.className = "fa-solid fa-circle-exclamation text-rose-400 text-lg";
      } else {
        toastIcon.className = "fa-solid fa-circle-check text-emerald-400 text-lg";
      }

      toast.classList.remove('translate-y-20', 'opacity-0');
      toast.classList.add('translate-y-0', 'opacity-100');

      setTimeout(() => {
        toast.classList.remove('translate-y-0', 'opacity-100');
        toast.classList.add('translate-y-20', 'opacity-0');
      }, 3000);
    }

    // Modal Helpers
    function openModal(id) {
      const el = document.getElementById(id);
      el.classList.remove('hidden');
      el.classList.add('flex');
    }

    function closeModal(id) {
      const el = document.getElementById(id);
      el.classList.add('hidden');
      el.classList.remove('flex');
    }

    // Calendar Navigation
    function changeMonth(delta) {
      currentDate.setMonth(currentDate.getMonth() + delta);
      renderCalendar();
    }

    function goToCurrentMonth() {
      currentDate = new Date();
      renderCalendar();
    }

    function toggleDashboardMonthMenu() {
      const menu = document.getElementById('dashboardMonthMenu');
      const isOpening = menu.classList.contains('hidden');
      menu.classList.toggle('hidden', !isOpening);
      document.getElementById('dashboardMonthToggle').setAttribute('aria-expanded', String(isOpening));
    }

    function toggleDashboardMonth(month, isSelected) {
      const selectedMonths = new Set(dashboardMonths);
      if (isSelected) selectedMonths.add(month);
      else selectedMonths.delete(month);
      dashboardMonths = [...selectedMonths].sort();
      render();
    }

    function clearDashboardMonths() {
      dashboardMonths = [];
      render();
    }

    function changeDashboardStudent(studentId) {
      dashboardStudent = studentId;
      render();
    }

    // Students Management
    function openAddStudentModal(studentId = null) {
      const student = studentId ? state.students.find(item => item.id === studentId) : null;
      document.getElementById('studentId').value = student?.id || '';
      document.getElementById('studentName').value = '';
      document.getElementById('studentEmail').value = '';
      document.getElementById('studentModalTitle').innerText = student ? "Modifier un élève" : "Ajouter un élève";
      document.getElementById('studentSubmitButton').innerText = student ? "Enregistrer les modifications" : "Enregistrer";
      if (student) {
        document.getElementById('studentName').value = student.name;
        document.getElementById('studentEmail').value = student.email || '';
      }
      openModal('studentModal');
      setTimeout(() => document.getElementById('studentName').focus(), 100);
    }

    function saveStudent(e) {
      e.preventDefault();
      const nameInput = document.getElementById('studentName');
      const name = nameInput.value.trim();
      const email = document.getElementById('studentEmail').value.trim();
      if (!name) return;

      const studentId = document.getElementById('studentId').value;
      const existingStudent = state.students.find(student => student.id === studentId);
      if (existingStudent) {
        existingStudent.name = name;
        existingStudent.email = email;
        showToast(`Élève ${name} modifié(e).`);
      } else {
        state.students.push({
          id: Date.now().toString(),
          name,
          email,
          subjects: []
        });
        showToast(`Élève ${name} ajouté(e) avec succès !`);
      }

      saveData();
      closeModal('studentModal');
    }

    function deleteStudent(id) {
      const student = state.students.find(s => s.id === id);
      if (confirm(`Voulez-vous vraiment supprimer l'élève ${student ? student.name : ''} ainsi que son historique ?`)) {
        state.students = state.students.filter(s => s.id !== id);
        state.sessions = state.sessions.filter(s => s.studentId !== id);
        saveData();
        showToast("Élève supprimé.", true);
      }
    }

    // Subject catalog and student assignments
    function openAddCatalogSubjectModal(subjectId = null) {
      document.getElementById('catalogSubjectForm').reset();
      const subject = subjectId ? state.subjects.find(item => item.id === subjectId) : null;
      document.getElementById('catalogSubjectId').value = subject?.id || '';
      document.getElementById('catalogSubjectName').value = subject?.name || '';
      document.getElementById('catalogSubjectModalTitle').innerText = subject ? "Modifier une matière" : "Nouvelle Matière";
      document.getElementById('catalogSubjectSubmitButton').innerText = subject ? "Enregistrer les modifications" : "Créer la matière";
      openModal('catalogSubjectModal');
      setTimeout(() => document.getElementById('catalogSubjectName').focus(), 100);
    }

    function saveCatalogSubject(e) {
      e.preventDefault();
      const name = document.getElementById('catalogSubjectName').value.trim();
      if (!name) return;
      const subjectId = document.getElementById('catalogSubjectId').value;

      if (state.subjects.some(subject => subject.id !== subjectId
        && subject.name.toLocaleLowerCase('fr') === name.toLocaleLowerCase('fr'))) {
        showToast("Cette matière existe déjà dans le catalogue.", true);
        return;
      }

      const existingSubject = state.subjects.find(subject => subject.id === subjectId);
      if (existingSubject) {
        existingSubject.name = name;
        state.students.forEach(student => {
          student.subjects.forEach(assignment => {
            if (assignment.id === subjectId) assignment.name = name;
          });
        });
        showToast(`Matière ${name} modifiée.`);
      } else {
        state.subjects.push({ id: `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, name });
        showToast(`Matière ${name} ajoutée au catalogue.`);
      }
      saveData();
      closeModal('catalogSubjectModal');
    }

    function deleteCatalogSubject(subjectId) {
      const isAssigned = state.students.some(student => student.subjects.some(subject => subject.id === subjectId));
      const hasSessions = state.sessions.some(session => session.subjectId === subjectId);
      if (isAssigned || hasSessions) {
        showToast("Impossible de supprimer une matière déjà affectée ou utilisée dans des séances.", true);
        return;
      }

      const subject = state.subjects.find(item => item.id === subjectId);
      if (!subject || !confirm(`Supprimer la matière ${subject.name} du catalogue ?`)) return;
      state.subjects = state.subjects.filter(item => item.id !== subjectId);
      saveData();
      showToast("Matière supprimée du catalogue.");
    }

    function openAddSubjectModal(studentId, subjectId = null) {
      document.getElementById('subjectStudentId').value = studentId;
      const student = state.students.find(item => item.id === studentId);
      const assigned = student?.subjects.find(item => item.id === subjectId);
      const select = document.getElementById('subjectCatalogSelect');
      const availableSubjects = state.subjects.filter(subject =>
        subjectId === subject.id || !student?.subjects.some(item => item.id === subject.id)
      );

      document.getElementById('subjectModalTitle').innerText = subjectId
        ? "Modifier l'honoraire de la matière"
        : "Affecter une matière à l'élève";
      select.innerHTML = availableSubjects.length
        ? availableSubjects.map(subject => `<option value="${subject.id}">${escapeHTML(subject.name)}</option>`).join('')
        : `<option value="">Aucune matière disponible — créez-en une dans le catalogue</option>`;
      select.disabled = Boolean(subjectId) || availableSubjects.length === 0;
      document.getElementById('subjectRate').value = assigned ? assigned.rate : '';
      document.querySelector('#subjectForm button[type="submit"]').disabled = availableSubjects.length === 0;
      document.querySelector('#subjectForm button[type="submit"]').classList.toggle('opacity-50', availableSubjects.length === 0);
      if (subjectId && assigned) select.value = subjectId;

      openModal('subjectModal');
      setTimeout(() => (subjectId ? document.getElementById('subjectRate') : select).focus(), 100);
    }

    function syncAssignmentRate() {
      const studentId = document.getElementById('subjectStudentId').value;
      const subjectId = document.getElementById('subjectCatalogSelect').value;
      const assigned = state.students.find(student => student.id === studentId)?.subjects.find(subject => subject.id === subjectId);
      document.getElementById('subjectRate').value = assigned ? assigned.rate : '';
    }

    function saveSubject(e) {
      e.preventDefault();
      const studentId = document.getElementById('subjectStudentId').value;
      const subjectId = document.getElementById('subjectCatalogSelect').value;
      const rate = parseFloat(document.getElementById('subjectRate').value);

      if (!subjectId || !Number.isFinite(rate) || rate < 0) {
        showToast("Saisie invalide pour l'affectation de la matière.", true);
        return;
      }

      const student = state.students.find(s => s.id === studentId);
      const subject = state.subjects.find(item => item.id === subjectId);
      if (!student || !subject) {
        showToast("Élève ou matière introuvable.", true);
        return;
      }

      const assignment = student.subjects.find(item => item.id === subjectId);
      if (assignment) {
        assignment.rate = rate;
        showToast(`Honoraire de ${subject.name} mis à jour (${rate} TND).`);
      } else {
        student.subjects.push({ id: subject.id, name: subject.name, rate });
        showToast(`Matière ${subject.name} affectée (${rate} TND).`);
      }
      saveData();
      closeModal('subjectModal');
    }

    function deleteSubject(studentId, subjectId) {
      const student = state.students.find(s => s.id === studentId);
      if (student) {
        const assignment = student.subjects.find(subject => subject.id === subjectId);
        state.sessions.forEach(session => {
          if (session.studentId === studentId && session.subjectId === subjectId && session.rate === undefined && assignment) {
            session.rate = assignment.rate;
          }
        });
        student.subjects = student.subjects.filter(sub => sub.id !== subjectId);
        saveData();
        showToast("Affectation supprimée. Les tarifs des séances passées sont conservés.");
      }
    }

    // Sessions & Calendar Modals
    function openSessionModal(dateStr) {
      document.getElementById('sessionDate').value = dateStr;
      document.getElementById('sessionTime').value = '';
      resetSessionForm();

      const dateObj = new Date(dateStr + 'T00:00:00');
      document.getElementById('sessionDateLabel').innerText = dateObj.toLocaleDateString('fr-FR', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
      });

      const studentSelect = document.getElementById('sessionStudent');
      const submitBtn = document.getElementById('submitSessionBtn');

      if (state.students.length === 0) {
        studentSelect.innerHTML = `<option value="">-- Aucun élève disponible --</option>`;
        document.getElementById('sessionSubject').innerHTML = `<option value="">-- N/A --</option>`;
        document.getElementById('sessionCustomRate').value = '';
        submitBtn.disabled = true;
        submitBtn.classList.add('opacity-50', 'cursor-not-allowed');
      } else {
        submitBtn.disabled = false;
        submitBtn.classList.remove('opacity-50', 'cursor-not-allowed');
        studentSelect.innerHTML = state.students.map(s => `<option value="${s.id}">${escapeHTML(s.name)}</option>`).join('');
        updateSubjectOptions();
      }

      renderDaySessions(dateStr);
      openModal('sessionModal');
    }

    function updateSubjectOptions() {
      const studentId = document.getElementById('sessionStudent').value;
      const subjectSelect = document.getElementById('sessionSubject');
      const submitBtn = document.getElementById('submitSessionBtn');
      const student = state.students.find(s => s.id === studentId);

      if (student && student.subjects && student.subjects.length > 0) {
        subjectSelect.innerHTML = student.subjects.map(sub => 
          `<option value="${sub.id}">${escapeHTML(sub.name)} (Base: ${sub.rate} TND)</option>`
        ).join('');
        submitBtn.disabled = false;
        submitBtn.classList.remove('opacity-50', 'cursor-not-allowed');
        syncDefaultRateForSession();
      } else {
        subjectSelect.innerHTML = `<option value="">-- Aucune matière enregistrée --</option>`;
        document.getElementById('sessionCustomRate').value = '';
        submitBtn.disabled = true;
        submitBtn.classList.add('opacity-50', 'cursor-not-allowed');
      }
    }

    function syncDefaultRateForSession() {
      if (document.getElementById('sessionEditId').value) return; // Keep custom rate when editing
      const studentId = document.getElementById('sessionStudent').value;
      const subjectId = document.getElementById('sessionSubject').value;
      const student = state.students.find(s => s.id === studentId);
      const sub = student?.subjects.find(s => s.id === subjectId);
      
      if (sub) {
        document.getElementById('sessionCustomRate').value = sub.rate;
      }
    }

    function resetSessionForm() {
      document.getElementById('sessionEditId').value = '';
      document.getElementById('submitSessionText').innerText = "Enregistrer cette séance";
      document.getElementById('cancelSessionEditBtn').classList.add('hidden');
      if (state.students.length > 0) {
        updateSubjectOptions();
      }
    }

    function getLocalTime(isoDate) {
      const date = new Date(isoDate);
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    }

    function editSession(sessionId) {
      const sess = state.sessions.find(s => s.id === sessionId);
      if (!sess) return;

      document.getElementById('sessionEditId').value = sess.id;
      document.getElementById('sessionStudent').value = sess.studentId;
      updateSubjectOptions();
      document.getElementById('sessionSubject').value = sess.subjectId;
      document.getElementById('sessionCustomRate').value = sess.rate;
      document.getElementById('sessionTime').value = sess.startAt ? getLocalTime(sess.startAt) : '';

      document.getElementById('submitSessionText').innerText = "Mettre à jour séance";
      document.getElementById('cancelSessionEditBtn').classList.remove('hidden');
    }

    function saveSession(e) {
      e.preventDefault();
      const date = document.getElementById('sessionDate').value;
      const editId = document.getElementById('sessionEditId').value;
      const studentId = document.getElementById('sessionStudent').value;
      const subjectId = document.getElementById('sessionSubject').value;
      const time = document.getElementById('sessionTime').value;
      const customRate = parseFloat(document.getElementById('sessionCustomRate').value);

      if (!studentId || !subjectId || !time || isNaN(customRate)) {
        showToast("Saisie invalide pour la séance.", true);
        return;
      }

      const startAt = new Date(`${date}T${time}`);
      if (Number.isNaN(startAt.getTime())) {
        showToast("Heure invalide pour la séance.", true);
        return;
      }

      // Autre matière : aucun blocage. Même matière déjà réglée : on autorise, mais
      // on avertit et on demande validation (l'échéance payée sera recomposée).
      if (sessionAffectsPaidCycle(studentId, subjectId, date, editId || null)) {
        const subjectName = (state.subjects.find(s => s.id === subjectId) || {}).name || 'cette matière';
        const confirmed = confirm(
          `Attention : la matière « ${subjectName} » a déjà une échéance réglée couvrant cette période.\n\n`
          + `Ajouter/modifier cette séance antérieure va recomposer l'échéance payée (le détail et le montant des séances réglées peuvent changer).\n\n`
          + `Voulez-vous continuer ?`
        );
        if (!confirmed) return;
      }

      if (editId) {
        // Update Session
        const sess = state.sessions.find(s => s.id === editId);
        if (sess) {
          sess.studentId = studentId;
          sess.subjectId = subjectId;
          sess.startAt = startAt.toISOString();
          sess.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
          sess.rate = customRate;
          showToast("Séance mise à jour !");
        }
      } else {
        // Add Session
        state.sessions.push({
          id: 'sess_' + Date.now(),
          date: date,
          startAt: startAt.toISOString(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
          studentId: studentId,
          subjectId: subjectId,
          rate: customRate
        });
        showToast("Séance enregistrée !");
      }

      saveData();
      resetSessionForm();
      renderDaySessions(date);
    }

    function deleteSession(id, dateStr) {
      state.sessions = state.sessions.filter(s => s.id !== id);
      saveData();
      renderDaySessions(dateStr);
      showToast("Séance annulée.", true);
    }

    function renderDaySessions(dateStr) {
      const listContainer = document.getElementById('daySessionsList');
      const daySessions = state.sessions.filter(s => s.date === dateStr);

      if (daySessions.length === 0) {
        listContainer.innerHTML = `<p class="text-xs text-slate-400 italic py-2">Aucune séance pour cette date.</p>`;
        return;
      }

      listContainer.innerHTML = daySessions.map(s => {
        const student = state.students.find(st => st.id === s.studentId);
        const subject = student?.subjects.find(sub => sub.id === s.subjectId)
          || state.subjects.find(item => item.id === s.subjectId);
        const sessionPrice = s.rate !== undefined ? s.rate : (subject ? subject.rate : 0);

        return `
          <div class="flex justify-between items-center bg-white p-2.5 rounded-lg border border-slate-200 text-xs shadow-sm">
            <div>
              <span class="font-bold text-slate-800">${escapeHTML(student ? student.name : 'Inconnu')}</span>
              <span class="text-slate-400 font-normal"> • </span>
              <span class="text-slate-500">${s.startAt ? escapeHTML(getLocalTime(s.startAt)) : 'Heure à définir'}</span>
              <span class="text-slate-400 font-normal"> • </span>
              <span class="text-indigo-600 font-medium">${escapeHTML(subject ? subject.name : 'Inconnu')}</span>
              <span class="text-emerald-600 font-bold ml-1">(${sessionPrice} TND)</span>
            </div>
            <div class="flex items-center gap-1">
              <button type="button" onclick="editSession('${s.id}')" class="text-slate-400 hover:text-indigo-600 p-1 transition" title="Modifier">
                <i class="fa-solid fa-pen"></i>
              </button>
              <button type="button" onclick="deleteSession('${s.id}', '${dateStr}')" class="text-slate-400 hover:text-rose-600 p-1 transition" title="Supprimer">
                <i class="fa-solid fa-trash-can"></i>
              </button>
            </div>
          </div>
        `;
      }).join('');
    }

    // Toggle Payment State
    function togglePayment(key) {
      state.payments[key] = !state.payments[key];
      saveData();
      showToast(state.payments[key] ? "Échéance marquée comme réglée !" : "Échéance remise en cours.");
    }

    // Dashboard Analytics Render
    function renderDashboard(index) {
      let totalGlobal = 0;
      const byStudent = new Map();
      const bySubject = new Map();
      const byMonth = new Map();
      const months = [...new Set(state.sessions
        .map(session => session.date?.substring(0, 7))
        .filter(month => /^\d{4}-\d{2}$/.test(month)))].sort().reverse();
      dashboardMonths = dashboardMonths.filter(month => months.includes(month));
      if (dashboardStudent !== 'all' && !index.studentsById.has(dashboardStudent)) dashboardStudent = 'all';
      document.getElementById('dashboardMonthOptions').innerHTML = months.length
        ? months.map(month => {
        const [year, monthNumber] = month.split('-');
        const label = new Date(Number(year), Number(monthNumber) - 1, 1)
          .toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
        return `
          <label class="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
            <input type="checkbox" value="${month}" ${dashboardMonths.includes(month) ? 'checked' : ''} onchange="toggleDashboardMonth(this.value, this.checked)" class="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500">
            <span class="capitalize">${label}</span>
          </label>`;
      }).join('')
        : `<p class="text-xs text-slate-400 italic">Aucune séance enregistrée.</p>`;
      const monthLabel = dashboardMonths.length === 0
        ? 'Tous les mois'
        : dashboardMonths.length === 1
          ? new Date(Number(dashboardMonths[0].slice(0, 4)), Number(dashboardMonths[0].slice(5, 7)) - 1, 1)
            .toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })
          : `${dashboardMonths.length} mois sélectionnés`;
      document.getElementById('dashboardMonthLabel').innerText = monthLabel;
      const studentSelect = document.getElementById('dashboardStudent');
      studentSelect.innerHTML = `<option value="all">Tous les élèves</option>${state.students
        .map(student => `<option value="${escapeHTML(student.id)}">${escapeHTML(student.name)}</option>`)
        .join('')}`;
      studentSelect.value = dashboardStudent;
      const selectedMonthLabel = dashboardMonths.length === 0
        ? 'Tous les mois'
        : dashboardMonths.length === 1
          ? monthLabel
          : `${dashboardMonths.length} mois`;
      const selectedStudentLabel = dashboardStudent === 'all'
        ? ''
        : ` — ${index.studentsById.get(dashboardStudent).name}`;
      document.getElementById('statTotalLabel').innerText = `Dépenses — ${selectedMonthLabel}${selectedStudentLabel}`;

      state.sessions.forEach(s => {
        const student = index.studentsById.get(s.studentId);
        const subject = index.subjectsByStudent.get(s.studentId)?.get(s.subjectId)
          || index.subjectsById.get(s.subjectId);
        const cost = getSessionPrice(s, subject);

        const monthKey = s.date ? s.date.substring(0, 7) : 'Inconnu';
        const monthIsSelected = dashboardMonths.length === 0 || dashboardMonths.includes(monthKey);
        const studentIsSelected = dashboardStudent === 'all' || s.studentId === dashboardStudent;
        if (studentIsSelected && monthIsSelected) {
          byMonth.set(monthKey, (byMonth.get(monthKey) || 0) + cost);
        }
        if (!monthIsSelected || !studentIsSelected) return;

        totalGlobal += cost;
        const studentName = student ? student.name : 'Inconnu';
        byStudent.set(studentName, (byStudent.get(studentName) || 0) + cost);

        const subjectName = subject ? subject.name : 'Non spécifiée';
        bySubject.set(subjectName, (bySubject.get(subjectName) || 0) + cost);
      });

      document.getElementById('statTotalGlobal').innerText = `${totalGlobal.toFixed(3)} TND`;

      // Helper for bar rendering
      const renderBarGroup = (containerId, dataMap) => {
        const container = document.getElementById(containerId);
        const keys = [...dataMap.keys()];

        if (keys.length === 0) {
          container.innerHTML = `<p class="text-xs text-slate-400 italic">Aucune donnée disponible</p>`;
          return;
        }

        const maxVal = Math.max(...dataMap.values()) || 1;

        container.innerHTML = keys.map(key => {
          const val = dataMap.get(key);
          const pct = Math.round((val / maxVal) * 100);

          let label = key;
          if (containerId === 'dashByMonth' && key.length === 7) {
            const [y, m] = key.split('-');
            const d = new Date(parseInt(y), parseInt(m) - 1, 1);
            label = d.toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' });
          }

          return `
            <div>
              <div class="flex justify-between text-xs font-semibold text-slate-700 mb-1">
                <span>${escapeHTML(label)}</span>
                <span class="text-indigo-950 font-extrabold">${val.toFixed(2)} TND</span>
              </div>
              <div class="w-full bg-slate-200 h-2 rounded-full overflow-hidden">
                <div class="bg-indigo-600 h-full rounded-full" style="width: ${pct}%"></div>
              </div>
            </div>
          `;
        }).join('');
      };

      renderBarGroup('dashByStudent', byStudent);
      renderBarGroup('dashBySubject', bySubject);
      renderBarGroup('dashByMonth', byMonth);
    }

    // Global Render Functions
    function render() {
      const index = buildRenderIndex();
      renderDashboard(index);
      renderCatalogSubjects();
      renderStudents();
      renderCalendar(index);
      renderEcheances(index);
    }

    function renderStudents() {
      const container = document.getElementById('studentsList');
      if (state.students.length === 0) {
        container.innerHTML = `
          <div class="text-center py-6 bg-slate-50 rounded-xl border border-dashed border-slate-200">
            <i class="fa-solid fa-user-plus text-slate-300 text-2xl mb-2"></i>
            <p class="text-xs text-slate-500">Aucun élève enregistré.</p>
            <button onclick="openAddStudentModal()" class="mt-2 text-xs text-indigo-600 hover:underline font-semibold">+ Ajouter un élève</button>
          </div>`;
        return;
      }

      container.innerHTML = state.students.map(s => `
        <div class="border border-slate-200 rounded-xl p-3.5 bg-slate-50/50 hover:bg-slate-50 transition">
          <div class="flex justify-between items-center mb-2.5">
            <span class="font-bold text-slate-800 text-sm flex items-center gap-2">
              <i class="fa-solid fa-user-graduate text-indigo-500 text-xs"></i> ${escapeHTML(s.name)}
            </span>
            <div class="flex gap-1.5">
              <button onclick="openAddSubjectModal('${s.id}')" class="text-xs bg-indigo-100 hover:bg-indigo-200 text-indigo-700 font-semibold px-2 py-1 rounded-md transition" title="Affecter une matière">
                  + Affecter matière
              </button>
              <button onclick="openAddStudentModal('${s.id}')" class="text-slate-400 hover:text-indigo-600 p-1 transition" title="Modifier l'élève" aria-label="Modifier ${escapeHTML(s.name)}">
                <i class="fa-solid fa-pen"></i>
              </button>
              <button onclick="deleteStudent('${s.id}')" class="text-xs text-slate-400 hover:text-rose-600 p-1 transition" title="Supprimer l'élève">
                <i class="fa-solid fa-trash-can"></i>
              </button>
            </div>
          </div>
          <div class="space-y-1.5">
            ${s.subjects && s.subjects.length > 0 ? s.subjects.map(sub => `
              <div class="flex justify-between items-center text-xs bg-white px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-700">
                <span class="font-medium">${escapeHTML(sub.name)}</span>
                <div class="flex items-center gap-1.5">
                  <span class="font-bold text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-100">${sub.rate} TND</span>
                  <button onclick="openAddSubjectModal('${s.id}', '${sub.id}')" class="text-slate-400 hover:text-indigo-600 p-0.5 transition" title="Modifier le tarif">
                    <i class="fa-solid fa-pen text-[10px]"></i>
                  </button>
                  <button onclick="deleteSubject('${s.id}', '${sub.id}')" class="text-slate-300 hover:text-rose-500 p-0.5 transition" title="Supprimer matière">
                    <i class="fa-solid fa-xmark"></i>
                  </button>
                </div>
              </div>
            `).join('') : '<p class="text-xs text-slate-400 italic">Aucune matière enregistrée</p>'}
          </div>
        </div>
      `).join('');
    }

    function renderCatalogSubjects() {
      const container = document.getElementById('catalogSubjectsList');
      if (state.subjects.length === 0) {
        container.innerHTML = `<p class="text-xs text-slate-400 italic">Aucune matière au catalogue. Créez-en une pour l'affecter à un élève.</p>`;
        return;
      }

      container.innerHTML = state.subjects.map(subject => {
        const assignedCount = state.students.filter(student =>
          student.subjects.some(assignment => assignment.id === subject.id)
        ).length;
        return `
          <div class="flex justify-between items-center text-sm bg-slate-50 px-3 py-2 rounded-lg border border-slate-200">
            <span class="font-medium text-slate-700">${escapeHTML(subject.name)}</span>
            <div class="flex items-center gap-2">
              <span class="text-xs text-slate-500">${assignedCount} élève${assignedCount > 1 ? 's' : ''}</span>
              <button onclick="openAddCatalogSubjectModal('${subject.id}')" class="text-slate-400 hover:text-indigo-600 p-1 transition" title="Modifier la matière" aria-label="Modifier ${escapeHTML(subject.name)}">
                <i class="fa-solid fa-pen"></i>
              </button>
              <button onclick="deleteCatalogSubject('${subject.id}')" class="text-slate-400 hover:text-rose-600 p-1 transition" title="Supprimer du catalogue" aria-label="Supprimer ${escapeHTML(subject.name)} du catalogue">
                <i class="fa-solid fa-trash-can"></i>
              </button>
            </div>
          </div>
        `;
      }).join('');
    }

    function matchesDashboardFilters(session) {
      return (dashboardStudent === 'all' || session.studentId === dashboardStudent)
        && (dashboardMonths.length === 0 || dashboardMonths.includes(session.date.substring(0, 7)));
    }

    function renderCalendar(index = buildRenderIndex()) {
      const year = currentDate.getFullYear();
      const month = currentDate.getMonth();

      document.getElementById('calendarTitle').innerText = new Date(year, month, 1).toLocaleDateString('fr-FR', {
        month: 'long', year: 'numeric'
      });

      const firstDayOfMonth = new Date(year, month, 1);
      const lastDayOfMonth = new Date(year, month + 1, 0);

      // Starting day offset (Monday = 0, Sunday = 6)
      let startingDay = firstDayOfMonth.getDay() - 1;
      if (startingDay === -1) startingDay = 6;

      const totalDays = lastDayOfMonth.getDate();
      const grid = document.getElementById('calendarGrid');
      const cells = [];

      // Empty padding cells for start of month
      for (let i = 0; i < startingDay; i++) {
        cells.push(`<div class="bg-slate-50/50 border border-slate-100 rounded-xl min-h-[64px] p-1.5 opacity-30 select-none"></div>`);
      }

      const todayStr = new Date().toISOString().split('T')[0];

      // Day cells
      for (let day = 1; day <= totalDays; day++) {
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const daySessions = (index.sessionsByDate.get(dateStr) || []).filter(matchesDashboardFilters);
        const isToday = dateStr === todayStr;

        let sessionsBadges = daySessions.map(s => {
          const student = index.studentsById.get(s.studentId);
          const subject = index.subjectsByStudent.get(s.studentId)?.get(s.subjectId)
            || index.subjectsById.get(s.subjectId);
          const price = getSessionPrice(s, subject);

          return `
            <div class="text-[10px] bg-indigo-100 text-indigo-900 font-semibold px-1.5 py-0.5 rounded border border-indigo-200 truncate mb-1 shadow-2xs flex justify-between items-center" title="${escapeHTML(student ? student.name : '')}">
              <span>${escapeHTML(student ? student.name : 'Inconnu')}</span>
              <span class="text-[9px] font-bold text-emerald-700 ml-1">${price}d</span>
            </div>`;
        }).join('');

        cells.push(`
          <div onclick="openSessionModal('${dateStr}')" class="bg-white border ${isToday ? 'border-indigo-600 ring-2 ring-indigo-200' : 'border-slate-200'} rounded-xl min-h-[68px] p-1.5 hover:bg-slate-50 cursor-pointer transition flex flex-col justify-between group shadow-2xs">
            <div class="flex justify-between items-center mb-1">
              <span class="text-xs font-bold ${isToday ? 'bg-indigo-600 text-white rounded-full w-5 h-5 flex items-center justify-center shadow-xs' : 'text-slate-700 group-hover:text-indigo-600'}">${day}</span>
              ${daySessions.length > 0 ? `<span class="text-[9px] bg-emerald-100 text-emerald-800 font-bold px-1 rounded-full">${daySessions.length}</span>` : ''}
            </div>
            <div class="overflow-y-auto max-h-12 scrollbar-none">
              ${sessionsBadges}
            </div>
          </div>
        `);
      }
      grid.innerHTML = cells.join('');
    }

    function renderEcheances(index) {
      const container = document.getElementById('echeancesList');
      const countLabel = document.getElementById('echeanceCount');
      const echeances = [];

      let totalEcheancesCount = 0;

      if (state.students.length === 0) {
        container.innerHTML = `<p class="text-xs text-slate-400 italic">Ajoutez des élèves et des cours pour voir vos échéances.</p>`;
        countLabel.innerText = "0";
        return;
      }

      state.students.forEach(student => {
        const studentSessions = (index.sessionsByStudent.get(student.id) || [])
          .slice();

        if (studentSessions.length === 0
          || (dashboardStudent !== 'all' && student.id !== dashboardStudent)) return;

        getStudentSessionCycles(studentSessions).forEach(cycle => {
          const blockSessions = cycle.sessions;
          if (!blockSessions.some(matchesDashboardFilters)) return;
          totalEcheancesCount++;
          const paymentKey = cyclePaymentKey(student.id, cycle.subjectId, cycle.subjectCycleNumber);
          const isPaid = !!state.payments[paymentKey];

          const totalAmount = blockSessions.reduce((sum, s) => {
            const subject = index.subjectsByStudent.get(student.id)?.get(s.subjectId)
              || index.subjectsById.get(s.subjectId);
            return sum + getSessionPrice(s, subject);
          }, 0);
          const isComplete = blockSessions.length === 4;
          const subjectName = index.subjectsByStudent.get(student.id)?.get(cycle.subjectId)?.name
            || index.subjectsById.get(cycle.subjectId)?.name
            || 'Matière inconnue';

          echeances.push(`
            <div class="border rounded-xl p-3 transition shadow-2xs ${isPaid ? 'bg-emerald-50/60 border-emerald-200' : isComplete ? 'bg-amber-50/60 border-amber-200' : 'bg-slate-50 border-slate-200'}">
              <div class="flex justify-between items-center mb-1">
                <span class="font-bold text-xs text-slate-800 flex items-center gap-1.5">
                  <i class="fa-solid fa-layer-group text-slate-400 text-[10px]"></i> ${escapeHTML(student.name)} - ${escapeHTML(subjectName)} - Échéance ${cycle.subjectCycleNumber}
                </span>
                <span class="text-xs font-bold ${isPaid ? 'text-emerald-700' : 'text-slate-800'}">${totalAmount.toFixed(2)} TND</span>
              </div>
              <p class="text-[11px] text-slate-600 mb-2">
                <span class="font-semibold">Matière :</span>
                ${escapeHTML(subjectName)}
              </p>
              <div class="flex justify-between items-center text-[11px] text-slate-500 mb-2">
                <span>${blockSessions.length} / 4 séances effectuées</span>
                <span class="font-bold ${isPaid ? 'text-emerald-600' : isComplete ? 'text-amber-600' : 'text-slate-400'}">
                  ${isPaid ? 'Payée' : isComplete ? 'À régler' : 'En cours'}
                </span>
              </div>
              <button onclick="togglePayment('${paymentKey}')" class="w-full py-1.5 rounded-lg text-xs font-bold transition flex items-center justify-center gap-1.5 active:scale-95 ${isPaid ? 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-xs' : 'bg-white hover:bg-slate-100 text-slate-700 border border-slate-300'}">
                ${isPaid ? '<i class="fa-solid fa-circle-check"></i> Payée' : 'Marquer comme Payée'}
              </button>
            </div>
          `);
        });
      });

      countLabel.innerText = totalEcheancesCount.toString();
      container.innerHTML = echeances.length > 0
        ? echeances.join('')
        : `<p class="text-xs text-slate-400 italic">Aucune séance enregistrée.</p>`;
    }

    // EXPORT & IMPORT XML / CSV
    function exportXML() {
      let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<tutoringData currency="TND">\n`;

      xml += `  <catalog>\n`;
      state.subjects.forEach(subject => {
        xml += `    <subject id="${subject.id}">\n`;
        xml += `      <name>${escapeXML(subject.name)}</name>\n`;
        xml += `    </subject>\n`;
      });
      xml += `  </catalog>\n`;

      xml += `  <students>\n`;
      state.students.forEach(s => {
        xml += `    <student id="${s.id}">\n`;
        xml += `      <name>${escapeXML(s.name)}</name>\n`;
        xml += `      <email>${escapeXML(s.email || '')}</email>\n`;
        xml += `      <subjects>\n`;
        if (s.subjects) {
          s.subjects.forEach(sub => {
            xml += `        <subject id="${sub.id}">\n`;
            xml += `          <name>${escapeXML(sub.name)}</name>\n`;
            xml += `          <rate>${sub.rate}</rate>\n`;
            xml += `        </subject>\n`;
          });
        }
        xml += `      </subjects>\n`;
        xml += `    </student>\n`;
      });
      xml += `  </students>\n`;

      xml += `  <sessions>\n`;
      state.sessions.forEach(s => {
        xml += `    <session id="${s.id}">\n`;
        xml += `      <date>${s.date}</date>\n`;
        xml += `      <time>${s.startAt ? getLocalTime(s.startAt) : ''}</time>\n`;
        xml += `      <timeZone>${escapeXML(s.timeZone || '')}</timeZone>\n`;
        xml += `      <studentId>${s.studentId}</studentId>\n`;
        xml += `      <subjectId>${s.subjectId}</subjectId>\n`;
        xml += `      <rate>${s.rate !== undefined ? s.rate : ''}</rate>\n`;
        xml += `    </session>\n`;
      });
      xml += `  </sessions>\n`;

      xml += `</tutoringData>`;

      downloadFile(xml, 'cours_particuliers_tnd.xml', 'text/xml');
      showToast("Fichier XML généré avec succès !");
    }

    function exportCSV() {
      let csv = "Date;Heure;Eleve;Matiere;Tarif_TND\n";
      state.sessions.forEach(s => {
        const student = state.students.find(st => st.id === s.studentId);
        const subject = student?.subjects.find(sub => sub.id === s.subjectId)
          || state.subjects.find(item => item.id === s.subjectId);
        const price = s.rate !== undefined ? s.rate : (subject ? subject.rate : 0);
        const time = s.startAt ? getLocalTime(s.startAt) : '';
        csv += `"${s.date}";"${time}";"${student?.name || ''}";"${subject?.name || ''}";"${price}"\n`;
      });
      downloadFile(csv, 'seances_cours_tnd.csv', 'text/csv;charset=utf-8;');
      showToast("Fichier CSV généré avec succès !");
    }

    function importXML(e) {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = function(event) {
        try {
          const parser = new DOMParser();
          const xmlDoc = parser.parseFromString(event.target.result, "text/xml");
          if (xmlDoc.querySelector('parsererror')) throw new Error("XML invalide");

          const newSubjects = [...xmlDoc.querySelectorAll('catalog > subject')].map(subject => ({
            id: subject.getAttribute('id'),
            name: subject.getElementsByTagName('name')[0]?.textContent || ''
          }));

          const newStudents = [];
          const studentNodes = xmlDoc.getElementsByTagName("student");
          for (let i = 0; i < studentNodes.length; i++) {
            const st = studentNodes[i];
            const id = st.getAttribute("id");
            const name = st.getElementsByTagName("name")[0].textContent;
            const email = st.getElementsByTagName("email")[0]?.textContent || '';

            const subjects = [];
            const subNodes = st.getElementsByTagName("subject");
            for (let j = 0; j < subNodes.length; j++) {
              const sub = subNodes[j];
              subjects.push({
                id: sub.getAttribute("id"),
                name: sub.getElementsByTagName("name")[0]?.textContent || '',
                rate: parseFloat(sub.getElementsByTagName("rate")[0]?.textContent)
              });
            }

            newStudents.push({ id, name, email, subjects });
          }

          const newSessions = [];
          const sessionNodes = xmlDoc.getElementsByTagName("session");
          for (let i = 0; i < sessionNodes.length; i++) {
            const se = sessionNodes[i];
            const rateNode = se.getElementsByTagName("rate")[0];
            const rateVal = rateNode && rateNode.textContent ? parseFloat(rateNode.textContent) : undefined;
            const date = se.getElementsByTagName("date")[0].textContent;
            const time = se.getElementsByTagName("time")[0]?.textContent;
            const startAt = time ? new Date(`${date}T${time}`).toISOString() : null;
            const timeZone = se.getElementsByTagName("timeZone")[0]?.textContent
              || (time ? Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' : null);

            newSessions.push({
              id: se.getAttribute("id"),
              date,
              startAt,
              timeZone,
              studentId: se.getElementsByTagName("studentId")[0].textContent,
              subjectId: se.getElementsByTagName("subjectId")[0].textContent,
              rate: rateVal
            });
          }

          state.subjects = newSubjects;
          state.students = newStudents;
          state.sessions = newSessions;
          normalizeSubjectCatalog();
          saveData();
          showToast("Données importées avec succès !");
        } catch (err) {
          showToast("Erreur lors de la lecture du fichier XML.", true);
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    }

    function escapeXML(str) {
      return str.replace(/[<>&'"]/g, c => {
        switch (c) {
          case '<': return '&lt;';
          case '>': return '&gt;';
          case '&': return '&amp;';
          case '\'': return '&apos;';
          case '"': return '&quot;';
        }
      });
    }

    function escapeHTML(value) {
      return String(value).replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[character]);
    }

    function downloadFile(content, filename, contentType) {
      const blob = new Blob([content], { type: contentType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    }

    // Startup
    window.onload = async function() {
      try {
        await initializeApplication();
      } catch (error) {
        console.error(error);
        showAuthMessage(getSupabaseError(error), true);
      }
    };

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./service-worker.js')
          .catch(error => console.error('Échec de l’enregistrement du service worker :', error));
      });
    }
